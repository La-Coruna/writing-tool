(function () {
  const graphemeSegmenter =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter("ko", { granularity: "grapheme" })
      : null;

  const wordSegmenter =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter("ko", { granularity: "word" })
      : null;

  const BRACKET_GROUPS = {
    round: {
      "(": ")",
      "（": "）",
    },
    square: {
      "[": "]",
    },
    angle: {
      "<": ">",
    },
  };

  const MAX_LCS_CELLS = 2_000_000;
  const STORAGE_KEY = "writing-tool-state-v1";
  const MERGE_SEGMENT_CLASSES = new Set(["", "token-merge", "token-manual-edit"]);

  const dom = {
    countInput: document.getElementById("countInput"),
    excludeRoundBrackets: document.getElementById("excludeRoundBrackets"),
    excludeSquareBrackets: document.getElementById("excludeSquareBrackets"),
    excludeAngleBrackets: document.getElementById("excludeAngleBrackets"),
    countWithSpace: document.getElementById("countWithSpace"),
    countWithoutSpace: document.getElementById("countWithoutSpace"),
    compareNow: document.getElementById("compareNow"),
    swapTexts: document.getElementById("swapTexts"),
    startMerge: document.getElementById("startMerge"),
    leftText: document.getElementById("leftText"),
    rightText: document.getElementById("rightText"),
    leftCountWithSpace: document.getElementById("leftCountWithSpace"),
    leftCountWithoutSpace: document.getElementById("leftCountWithoutSpace"),
    rightCountWithSpace: document.getElementById("rightCountWithSpace"),
    rightCountWithoutSpace: document.getElementById("rightCountWithoutSpace"),
    diffGrid: document.getElementById("diffGrid"),
    copyLeftText: document.getElementById("copyLeftText"),
    copyRightText: document.getElementById("copyRightText"),
    leftDiff: document.getElementById("leftDiff"),
    rightDiff: document.getElementById("rightDiff"),
    mergePanel: document.getElementById("mergePanel"),
    copyMergeResult: document.getElementById("copyMergeResult"),
    mergeCountWithSpace: document.getElementById("mergeCountWithSpace"),
    mergeCountWithoutSpace: document.getElementById("mergeCountWithoutSpace"),
    mergeDiff: document.getElementById("mergeDiff"),
    selectionCountBadge: document.getElementById("selectionCountBadge"),
    selectionCountText: document.getElementById("selectionCountText"),
    applySelectionToMerge: document.getElementById("applySelectionToMerge"),
    editMergeSelection: document.getElementById("editMergeSelection"),
    cancelManualEdit: document.getElementById("cancelManualEdit"),
  };

  let diffDebounceId = null;
  let storageEnabled = true;
  let mergeActive = false;
  let mergeSelections = {};
  let currentBlocks = [];
  let currentMergedText = "";
  let currentMergeSegments = [];
  let manualMergeSegments = null;
  let selectionPointer = null;
  let selectedMergeChoices = {};
  let selectedManualEditRange = null;
  let selectedManualCancelRange = null;
  const autoGrowTextareas = [dom.countInput, dom.leftText, dom.rightText];
  const bracketOptionInputs = [
    dom.excludeRoundBrackets,
    dom.excludeSquareBrackets,
    dom.excludeAngleBrackets,
  ];

  function getExcludedBracketTypes() {
    return {
      round: dom.excludeRoundBrackets.checked,
      square: dom.excludeSquareBrackets.checked,
      angle: dom.excludeAngleBrackets.checked,
    };
  }

  function hasExcludedBracketTypes() {
    return Object.values(getExcludedBracketTypes()).some(Boolean);
  }

  function getActiveBracketPairs() {
    const excludedBracketTypes = getExcludedBracketTypes();
    return Object.entries(excludedBracketTypes).reduce((pairs, [type, enabled]) => {
      if (enabled) {
        Object.assign(pairs, BRACKET_GROUPS[type]);
      }
      return pairs;
    }, {});
  }

  function loadState() {
    if (!storageEnabled) {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return parsed;
    } catch (_error) {
      storageEnabled = false;
      return null;
    }
  }

  function normalizeMergeSelections(value) {
    if (!value || typeof value !== "object") {
      return {};
    }

    return Object.entries(value).reduce((selections, [changeId, side]) => {
      if (side === "left" || side === "right") {
        selections[String(changeId)] = side;
      }
      return selections;
    }, {});
  }

  function normalizeSegmentList(value, includeOriginals = false) {
    if (!Array.isArray(value)) {
      return null;
    }

    const segments = value
      .filter((segment) => segment && typeof segment.text === "string")
      .map((segment) => {
        const className =
          typeof segment.className === "string" && MERGE_SEGMENT_CLASSES.has(segment.className)
            ? segment.className
            : "";
        const normalized = {
          text: segment.text,
          className,
        };

        if (typeof segment.changeId === "string") {
          normalized.changeId = segment.changeId;
        }

        if (Array.isArray(segment.changeIds)) {
          const changeIds = [...new Set(segment.changeIds.filter((id) => typeof id === "string"))];
          if (changeIds.length > 0) {
            normalized.changeIds = changeIds;
          }
        }

        if (includeOriginals && Array.isArray(segment.originalSegments)) {
          const originalSegments = normalizeSegmentList(segment.originalSegments, false);
          if (originalSegments && originalSegments.length > 0) {
            normalized.originalSegments = originalSegments;
          }
        }

        return normalized;
      });

    return segments;
  }

  function normalizeMergeSegments(value) {
    return normalizeSegmentList(value, true);
  }

  function saveState() {
    if (!storageEnabled) {
      return;
    }
    const state = {
      countInput: dom.countInput.value,
      excludedBracketTypes: getExcludedBracketTypes(),
      leftText: dom.leftText.value,
      rightText: dom.rightText.value,
      mergeActive,
      mergeSelections,
      manualMergeSegments,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_error) {
      storageEnabled = false;
    }
  }

  function restoreState() {
    const state = loadState();
    if (!state) {
      return;
    }

    dom.countInput.value = typeof state.countInput === "string" ? state.countInput : "";
    dom.leftText.value = typeof state.leftText === "string" ? state.leftText : "";
    dom.rightText.value = typeof state.rightText === "string" ? state.rightText : "";

    const legacyExcludeBrackets = Boolean(state.excludeBrackets);
    const excludedBracketTypes =
      state.excludedBracketTypes && typeof state.excludedBracketTypes === "object"
        ? state.excludedBracketTypes
        : null;

    dom.excludeRoundBrackets.checked = excludedBracketTypes
      ? Boolean(excludedBracketTypes.round)
      : legacyExcludeBrackets;
    dom.excludeSquareBrackets.checked = excludedBracketTypes
      ? Boolean(excludedBracketTypes.square)
      : legacyExcludeBrackets;
    dom.excludeAngleBrackets.checked = excludedBracketTypes
      ? Boolean(excludedBracketTypes.angle)
      : legacyExcludeBrackets;

    mergeSelections = normalizeMergeSelections(state.mergeSelections);
    manualMergeSegments = state.mergeActive ? normalizeMergeSegments(state.manualMergeSegments) : null;
    setMergeActive(Boolean(state.mergeActive));
  }

  function countGraphemes(text) {
    if (!text) {
      return 0;
    }
    if (!graphemeSegmenter) {
      return Array.from(text).length;
    }
    let count = 0;
    for (const _ of graphemeSegmenter.segment(text)) {
      count += 1;
    }
    return count;
  }

  function formatCount(count) {
    return count.toLocaleString("ko-KR");
  }

  function updateMergeCounter(text) {
    const withSpace = countGraphemes(text);
    const withoutSpace = countGraphemes(text.replace(/\s/gu, ""));

    dom.mergeCountWithSpace.textContent = formatCount(withSpace);
    dom.mergeCountWithoutSpace.textContent = formatCount(withoutSpace);
  }

  function getSegmentsText(segments) {
    return segments.map((segment) => segment.text).join("");
  }

  function getSegmentChangeIds(segment) {
    const changeIds = [];
    if (typeof segment.changeId === "string") {
      changeIds.push(segment.changeId);
    }
    if (Array.isArray(segment.changeIds)) {
      changeIds.push(...segment.changeIds.filter((id) => typeof id === "string"));
    }
    return [...new Set(changeIds)];
  }

  function copySegment(segment, overrides = {}) {
    const next = {
      text: Object.prototype.hasOwnProperty.call(overrides, "text") ? overrides.text : segment.text,
      className: Object.prototype.hasOwnProperty.call(overrides, "className")
        ? overrides.className
        : segment.className || "",
    };
    const changeId = Object.prototype.hasOwnProperty.call(overrides, "changeId")
      ? overrides.changeId
      : segment.changeId;
    const changeIds = Object.prototype.hasOwnProperty.call(overrides, "changeIds")
      ? overrides.changeIds
      : segment.changeIds;
    const originalSegments = Object.prototype.hasOwnProperty.call(overrides, "originalSegments")
      ? overrides.originalSegments
      : segment.originalSegments;

    if (typeof changeId === "string") {
      next.changeId = changeId;
    }
    if (Array.isArray(changeIds) && changeIds.length > 0) {
      next.changeIds = [...new Set(changeIds.filter((id) => typeof id === "string"))];
    }
    if (Array.isArray(originalSegments) && originalSegments.length > 0) {
      next.originalSegments = originalSegments.map((originalSegment) => copySegment(originalSegment));
    }
    return next;
  }

  function arraysEqual(left, right) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => item === right[index]);
  }

  function canMergeSegments(left, right) {
    return (
      left.text &&
      right.text &&
      left.className !== "token-manual-edit" &&
      right.className !== "token-manual-edit" &&
      left.className === right.className &&
      left.changeId === right.changeId &&
      arraysEqual(getSegmentChangeIds(left), getSegmentChangeIds(right))
    );
  }

  function appendMergeSegment(parent, segment, index) {
    if (!segment.text) {
      return;
    }

    if (!segment.className) {
      parent.appendChild(document.createTextNode(segment.text));
      return;
    }

    const span = document.createElement("span");
    span.className = segment.className;
    span.textContent = segment.text;
    if (canCancelManualSegment(segment)) {
      span.dataset.manualEditIndex = String(index);
      span.title = "클릭하거나 드래그해서 직접 수정을 취소할 수 있습니다.";
    }
    parent.appendChild(span);
  }

  function renderMergeSegments(segments) {
    const renderedSegments = mergeAdjacentSegments(segments);
    const fragment = document.createDocumentFragment();
    for (const [index, segment] of renderedSegments.entries()) {
      appendMergeSegment(fragment, segment, index);
    }
    dom.mergeDiff.appendChild(fragment);
    currentMergeSegments = renderedSegments.map((segment) => copySegment(segment));
    currentMergedText = getSegmentsText(renderedSegments);
    updateMergeCounter(currentMergedText);
    updateCopyMergeButton();
  }

  function resetManualMergeEdits() {
    manualMergeSegments = null;
  }

  function updateCopyMergeButton() {
    dom.copyMergeResult.disabled = !currentMergedText;
  }

  function setCopyButtonLabel(button, label) {
    button.textContent = label;
  }

  function updateSourceCopyButtons() {
    dom.copyLeftText.disabled = !dom.leftText.value;
    dom.copyRightText.disabled = !dom.rightText.value;
  }

  function getElementFromNode(node) {
    if (!node) {
      return null;
    }
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function rangeIntersectsNode(range, node) {
    try {
      return range.intersectsNode(node);
    } catch (_error) {
      return false;
    }
  }

  function getDiffOutputs() {
    return [dom.leftDiff, dom.rightDiff, dom.mergeDiff].filter(Boolean);
  }

  function isSelectableDiffTextNode(node) {
    const element = getElementFromNode(node);
    if (!element) {
      return false;
    }
    return Boolean(element.closest(".diff-output")) && !element.closest(".token-placeholder");
  }

  function extractSelectedDiffText(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return "";
    }

    const range = selection.getRangeAt(0);
    const touchesDiffOutput = getDiffOutputs().some((output) => rangeIntersectsNode(range, output));
    if (!touchesDiffOutput) {
      return "";
    }

    const root =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
    if (!root) {
      return "";
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!isSelectableDiffTextNode(node) || !rangeIntersectsNode(range, node)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let selectedText = "";
    let textNode = walker.nextNode();
    while (textNode) {
      let start = 0;
      let end = textNode.nodeValue.length;
      if (textNode === range.startContainer) {
        start = range.startOffset;
      }
      if (textNode === range.endContainer) {
        end = range.endOffset;
      }
      selectedText += textNode.nodeValue.slice(start, end);
      textNode = walker.nextNode();
    }

    return selectedText;
  }

  function getSelectedMergeChoices(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return {};
    }

    const range = selection.getRangeAt(0);
    const choices = {};
    for (const output of [dom.leftDiff, dom.rightDiff]) {
      if (!rangeIntersectsNode(range, output)) {
        continue;
      }
      const changeElements = output.querySelectorAll("[data-change-id][data-side]");
      for (const element of changeElements) {
        if (!rangeIntersectsNode(range, element)) {
          continue;
        }
        const changeId = element.dataset.changeId;
        const side = element.dataset.side;
        if (changeId && (side === "left" || side === "right")) {
          choices[changeId] = side;
        }
      }
    }
    return choices;
  }

  function getSelectedTextRangeInElement(selection, root) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !root) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!rangeIntersectsNode(range, root)) {
      return null;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    let offset = 0;
    let start = null;
    let end = null;
    let text = "";
    let textNode = walker.nextNode();

    while (textNode) {
      const nodeText = textNode.nodeValue;
      if (!rangeIntersectsNode(range, textNode)) {
        offset += nodeText.length;
        textNode = walker.nextNode();
        continue;
      }
      const nodeStart = textNode === range.startContainer ? range.startOffset : 0;
      const nodeEnd = textNode === range.endContainer ? range.endOffset : nodeText.length;
      if (start === null) {
        start = offset + nodeStart;
      }
      end = offset + nodeEnd;
      text += nodeText.slice(nodeStart, nodeEnd);
      offset += nodeText.length;
      textNode = walker.nextNode();
    }

    if (start === null || end === null || start === end) {
      return null;
    }

    return { start, end, text };
  }

  function getSegmentRangesForTextRange(segments, start, end, predicate = () => true) {
    let offset = 0;
    const ranges = [];

    for (const [index, segment] of segments.entries()) {
      const segmentStart = offset;
      const segmentEnd = offset + segment.text.length;
      offset = segmentEnd;

      if (segmentEnd <= start || segmentStart >= end || !predicate(segment)) {
        continue;
      }

      ranges.push({
        index,
        start: segmentStart,
        end: segmentEnd,
        text: segment.text,
        segment,
      });
    }

    return ranges;
  }

  function getManualCancelRange(textRange) {
    const ranges = getSegmentRangesForTextRange(
      currentMergeSegments,
      textRange.start,
      textRange.end,
      canCancelManualSegment,
    );

    if (ranges.length === 0) {
      return null;
    }

    return {
      start: Math.min(...ranges.map((range) => range.start)),
      end: Math.max(...ranges.map((range) => range.end)),
      text: ranges.map((range) => range.text).join(""),
    };
  }

  function getTextRangeForSegmentIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= currentMergeSegments.length) {
      return null;
    }

    let offset = 0;
    for (const [segmentIndex, segment] of currentMergeSegments.entries()) {
      const start = offset;
      const end = offset + segment.text.length;
      if (segmentIndex === index) {
        return { start, end, text: segment.text };
      }
      offset = end;
    }

    return null;
  }

  function isDirectEditableRange(textRange) {
    const ranges = getSegmentRangesForTextRange(currentMergeSegments, textRange.start, textRange.end);
    return (
      ranges.length > 0 &&
      ranges.every((range) => {
        return range.segment.className !== "token-merge" && range.segment.className !== "token-manual-edit";
      })
    );
  }

  function getSelectionBadgePosition(selection) {
    if (selectionPointer) {
      return selectionPointer;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const rect = range ? range.getBoundingClientRect() : null;
    if (rect && (rect.width > 0 || rect.height > 0)) {
      return { x: rect.right, y: rect.top };
    }
    return { x: 0, y: 0 };
  }

  function hideSelectionBadge() {
    dom.selectionCountBadge.classList.add("is-hidden");
    selectedMergeChoices = {};
    selectedManualEditRange = null;
    selectedManualCancelRange = null;
  }

  function showSelectionBadge(count, position, mergeChoices, manualEditRange, manualCancelRange) {
    const hasMergeChoices = Object.keys(mergeChoices).length > 0;
    const hasManualEditRange = Boolean(manualEditRange);
    const hasManualCancelRange = Boolean(manualCancelRange);
    selectedMergeChoices = mergeChoices;
    selectedManualEditRange = manualEditRange;
    selectedManualCancelRange = manualCancelRange;
    dom.selectionCountText.textContent = `${formatCount(count)}자`;
    dom.applySelectionToMerge.disabled = !hasMergeChoices;
    dom.editMergeSelection.disabled = !hasManualEditRange;
    dom.cancelManualEdit.disabled = !hasManualCancelRange;
    dom.selectionCountBadge.classList.remove("is-hidden");

    const badgeRect = dom.selectionCountBadge.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - badgeRect.width - 20);
    const maxTop = Math.max(16, window.innerHeight - badgeRect.height - 8);
    const left = Math.min(Math.max(position.x, 8), maxLeft);
    const top = Math.min(Math.max(position.y, 16), maxTop);

    dom.selectionCountBadge.style.left = `${left}px`;
    dom.selectionCountBadge.style.top = `${top}px`;
  }

  function updateSelectionCountBadge() {
    const selection = window.getSelection();
    const selectedText = extractSelectedDiffText(selection);
    const selectedCount = countGraphemes(selectedText);
    const mergeChoices = getSelectedMergeChoices(selection);
    const mergeTextRange =
      mergeActive && currentMergeSegments.length > 0
        ? getSelectedTextRangeInElement(selection, dom.mergeDiff)
        : null;
    const manualEditRange =
      mergeTextRange && isDirectEditableRange(mergeTextRange) ? mergeTextRange : null;
    const manualCancelRange = mergeTextRange ? getManualCancelRange(mergeTextRange) : null;

    if (selectedCount === 0) {
      hideSelectionBadge();
      return;
    }

    showSelectionBadge(
      selectedCount,
      getSelectionBadgePosition(selection),
      mergeChoices,
      manualEditRange,
      manualCancelRange,
    );
  }

  function rememberSelectionPointer(event) {
    selectionPointer = { x: event.clientX, y: event.clientY };
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  function resizeAllTextareas() {
    for (const textarea of autoGrowTextareas) {
      autoResizeTextarea(textarea);
    }
  }

  function stripBracketContent(text, bracketPairs) {
    if (!text) {
      return "";
    }

    const closingStack = [];
    let output = "";

    for (const char of text) {
      if (Object.prototype.hasOwnProperty.call(bracketPairs, char)) {
        closingStack.push(bracketPairs[char]);
        continue;
      }

      if (closingStack.length > 0 && char === closingStack[closingStack.length - 1]) {
        closingStack.pop();
        continue;
      }

      if (closingStack.length > 0) {
        continue;
      }

      output += char;
    }

    return output;
  }

  function updateCounter() {
    const raw = dom.countInput.value;
    const applied = hasExcludedBracketTypes() ? stripBracketContent(raw, getActiveBracketPairs()) : raw;

    const withSpaceCount = countGraphemes(applied);
    const withoutSpaceCount = countGraphemes(applied.replace(/\s/gu, ""));

    dom.countWithSpace.textContent = withSpaceCount.toLocaleString("ko-KR");
    dom.countWithoutSpace.textContent = withoutSpaceCount.toLocaleString("ko-KR");
  }

  function updateDiffCounters(leftText, rightText) {
    const leftWithSpace = countGraphemes(leftText);
    const leftWithoutSpace = countGraphemes(leftText.replace(/\s/gu, ""));
    const rightWithSpace = countGraphemes(rightText);
    const rightWithoutSpace = countGraphemes(rightText.replace(/\s/gu, ""));

    dom.leftCountWithSpace.textContent = leftWithSpace.toLocaleString("ko-KR");
    dom.leftCountWithoutSpace.textContent = leftWithoutSpace.toLocaleString("ko-KR");
    dom.rightCountWithSpace.textContent = rightWithSpace.toLocaleString("ko-KR");
    dom.rightCountWithoutSpace.textContent = rightWithoutSpace.toLocaleString("ko-KR");
    updateSourceCopyButtons();
  }

  function tokenize(text) {
    if (!text) {
      return [];
    }

    if (wordSegmenter) {
      const tokens = [];
      for (const item of wordSegmenter.segment(text)) {
        tokens.push(item.segment);
      }
      return tokens;
    }

    return text
      .split(/(\s+|[.,!?;:()[\]{}"'’“”`~@#$%^&*+=|\\/<>-])/u)
      .filter(Boolean);
  }

  function quickAnchorDiff(leftTokens, rightTokens) {
    let prefix = 0;
    while (
      prefix < leftTokens.length &&
      prefix < rightTokens.length &&
      leftTokens[prefix] === rightTokens[prefix]
    ) {
      prefix += 1;
    }

    let leftSuffix = leftTokens.length - 1;
    let rightSuffix = rightTokens.length - 1;
    while (
      leftSuffix >= prefix &&
      rightSuffix >= prefix &&
      leftTokens[leftSuffix] === rightTokens[rightSuffix]
    ) {
      leftSuffix -= 1;
      rightSuffix -= 1;
    }

    const ops = [];
    for (let i = 0; i < prefix; i += 1) {
      ops.push({ type: "equal", token: leftTokens[i] });
    }

    for (let i = prefix; i <= leftSuffix; i += 1) {
      ops.push({ type: "delete", token: leftTokens[i] });
    }

    for (let i = prefix; i <= rightSuffix; i += 1) {
      ops.push({ type: "insert", token: rightTokens[i] });
    }

    for (let i = leftSuffix + 1; i < leftTokens.length; i += 1) {
      ops.push({ type: "equal", token: leftTokens[i] });
    }

    return ops;
  }

  function lcsDiff(leftTokens, rightTokens) {
    const n = leftTokens.length;
    const m = rightTokens.length;
    if (n * m > MAX_LCS_CELLS) {
      return quickAnchorDiff(leftTokens, rightTokens);
    }

    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = table[i];
      const nextRow = table[i + 1];
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] =
          leftTokens[i] === rightTokens[j]
            ? nextRow[j + 1] + 1
            : Math.max(nextRow[j], row[j + 1]);
      }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (leftTokens[i] === rightTokens[j]) {
        ops.push({ type: "equal", token: leftTokens[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ type: "delete", token: leftTokens[i] });
        i += 1;
      } else {
        ops.push({ type: "insert", token: rightTokens[j] });
        j += 1;
      }
    }

    while (i < n) {
      ops.push({ type: "delete", token: leftTokens[i] });
      i += 1;
    }

    while (j < m) {
      ops.push({ type: "insert", token: rightTokens[j] });
      j += 1;
    }

    return ops;
  }

  function buildBlocks(ops) {
    const blocks = [];
    let index = 0;
    let changeId = 0;

    while (index < ops.length) {
      const op = ops[index];
      if (op.type === "equal") {
        let text = "";
        while (index < ops.length && ops[index].type === "equal") {
          text += ops[index].token;
          index += 1;
        }
        blocks.push({ type: "equal", text });
        continue;
      }

      let deleted = "";
      let inserted = "";
      while (index < ops.length && ops[index].type !== "equal") {
        if (ops[index].type === "delete") {
          deleted += ops[index].token;
        } else {
          inserted += ops[index].token;
        }
        index += 1;
      }

      const id = String(changeId);
      changeId += 1;

      if (deleted && inserted) {
        blocks.push({ id, type: "replace", left: deleted, right: inserted });
      } else if (deleted) {
        blocks.push({ id, type: "delete", left: deleted });
      } else if (inserted) {
        blocks.push({ id, type: "insert", right: inserted });
      }
    }

    return blocks;
  }

  function appendText(parent, text, className) {
    if (!text) {
      return;
    }

    if (!className) {
      parent.appendChild(document.createTextNode(text));
      return;
    }

    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
  }

  function getBlockSideText(block, side) {
    if (block.type === "delete") {
      return side === "left" ? block.left : "";
    }
    if (block.type === "insert") {
      return side === "right" ? block.right : "";
    }
    if (block.type === "replace") {
      return side === "left" ? block.left : block.right;
    }
    return block.text || "";
  }

  function getBlockSideClass(block, side) {
    if (block.type === "delete") {
      return side === "left" ? "token-delete" : "token-delete token-placeholder";
    }
    if (block.type === "insert") {
      return side === "right" ? "token-insert" : "token-skip token-placeholder";
    }
    if (block.type === "replace") {
      return side === "left" ? "token-replace-left" : "token-replace-right";
    }
    return "";
  }

  function getEmptyChoiceLabel(block, side) {
    if (block.type === "delete" && side === "right") {
      return "삭제 적용";
    }
    if (block.type === "insert" && side === "left") {
      return "추가 안 함";
    }
    return "";
  }

  function appendDiffChoice(parent, block, side) {
    const text = getBlockSideText(block, side);

    if (!mergeActive) {
      if (!text) {
        return;
      }
      const span = document.createElement("span");
      span.className = `${getBlockSideClass(block, side)} diff-change`;
      span.dataset.changeId = block.id;
      span.dataset.side = side;
      span.textContent = text;
      parent.appendChild(span);
      return;
    }

    const label = text || getEmptyChoiceLabel(block, side);
    if (!label) {
      return;
    }

    const span = document.createElement("span");
    const isSelected = mergeSelections[block.id] === side;
    span.className = `${getBlockSideClass(block, side)} diff-choice${isSelected ? " selected" : ""}`;
    span.dataset.changeId = block.id;
    span.dataset.side = side;
    span.setAttribute("role", "button");
    span.tabIndex = 0;
    span.textContent = label;
    parent.appendChild(span);
  }

  function getMergeTextForChoice(block, side) {
    if (block.type === "delete") {
      return side === "left" ? block.left : "";
    }
    if (block.type === "insert") {
      return side === "right" ? block.right : "";
    }
    if (block.type === "replace") {
      return side === "right" ? block.right : block.left;
    }
    return block.text || "";
  }

  function renderMergeResult(blocks) {
    if (!mergeActive) {
      currentMergedText = "";
      currentMergeSegments = [];
      updateMergeCounter("");
      updateCopyMergeButton();
      return;
    }

    dom.mergeDiff.textContent = "";

    if (blocks.length === 0) {
      currentMergedText = "";
      currentMergeSegments = [];
      dom.mergeDiff.textContent = "병합할 텍스트를 입력하세요.";
      dom.mergeDiff.classList.add("empty");
      updateMergeCounter("");
      updateCopyMergeButton();
      return;
    }

    dom.mergeDiff.classList.remove("empty");

    if (manualMergeSegments) {
      renderMergeSegments(manualMergeSegments);
      return;
    }

    const segments = [];

    for (const block of blocks) {
      if (block.type === "equal") {
        segments.push({ text: block.text, className: "" });
        continue;
      }

      const explicitSide = mergeSelections[block.id];
      const selectedSide = explicitSide || "left";
      const text = getMergeTextForChoice(block, selectedSide);
      segments.push({
        text,
        className: explicitSide && text ? "token-merge" : "",
        changeId: block.id,
      });
    }

    renderMergeSegments(segments);
  }

  function resetMergeSelections() {
    mergeSelections = {};
  }

  function setMergeActive(active) {
    mergeActive = active;
    dom.diffGrid.classList.toggle("merge-active", mergeActive);
    dom.mergePanel.classList.toggle("is-hidden", !mergeActive);
    dom.startMerge.textContent = mergeActive ? "병합 다시 시작" : "병합 시작";
    dom.startMerge.setAttribute("aria-pressed", String(mergeActive));
  }

  function selectMergeChoice(changeId, side) {
    if (manualMergeSegments) {
      manualMergeSegments = applyMergeChoicesToSegments(currentMergeSegments, {
        [changeId]: side,
      });
    }
    mergeSelections[changeId] = side;
    renderDiff(dom.leftText.value, dom.rightText.value);
    saveState();
  }

  function isManualMergeSegment(segment) {
    return segment.className === "token-manual-edit";
  }

  function canCancelManualSegment(segment) {
    return (
      isManualMergeSegment(segment) &&
      ((Array.isArray(segment.originalSegments) && segment.originalSegments.length > 0) ||
        getSegmentChangeIds(segment).length > 0)
    );
  }

  function segmentHasAnchor(segment) {
    return (
      typeof segment.changeId === "string" ||
      getSegmentChangeIds(segment).length > 0 ||
      (Array.isArray(segment.originalSegments) && segment.originalSegments.length > 0)
    );
  }

  function mergeAdjacentSegments(segments) {
    return segments.reduce((merged, segment) => {
      if (!segment.text && !segmentHasAnchor(segment)) {
        return merged;
      }
      const nextSegment = copySegment(segment);
      const previous = merged[merged.length - 1];
      if (previous && canMergeSegments(previous, nextSegment)) {
        previous.text += nextSegment.text;
      } else {
        merged.push(nextSegment);
      }
      return merged;
    }, []);
  }

  function getBlockById(changeId) {
    return currentBlocks.find((block) => block.id === changeId) || null;
  }

  function createMergeChoiceSegment(block, side) {
    const text = getMergeTextForChoice(block, side);
    return {
      text,
      className: text ? "token-merge" : "",
      changeId: block.id,
    };
  }

  function segmentTouchesChangeId(segment, changeId) {
    return getSegmentChangeIds(segment).includes(changeId);
  }

  function hasManualOverrideForChangeId(segments, changeId) {
    return segments.some(
      (segment) => isManualMergeSegment(segment) && segmentTouchesChangeId(segment, changeId),
    );
  }

  function applyMergeChoiceToSegments(segments, changeId, side) {
    if (side !== "left" && side !== "right") {
      return segments.map((segment) => copySegment(segment));
    }

    const block = getBlockById(changeId);
    if (!block || hasManualOverrideForChangeId(segments, changeId)) {
      return segments.map((segment) => copySegment(segment));
    }

    const choiceSegment = createMergeChoiceSegment(block, side);
    let inserted = false;
    let foundTarget = false;
    const nextSegments = [];

    for (const segment of segments) {
      if (!isManualMergeSegment(segment) && segment.changeId === changeId) {
        foundTarget = true;
        if (!inserted) {
          nextSegments.push(choiceSegment);
          inserted = true;
        }
        continue;
      }

      nextSegments.push(copySegment(segment));
    }

    return foundTarget
      ? mergeAdjacentSegments(nextSegments)
      : segments.map((segment) => copySegment(segment));
  }

  function applyMergeChoicesToSegments(segments, choices) {
    return Object.entries(choices).reduce((nextSegments, [changeId, side]) => {
      return applyMergeChoiceToSegments(nextSegments, changeId, side);
    }, segments.map((segment) => copySegment(segment)));
  }

  function getCoveredChangeIdsForRange(segments, start, end) {
    let offset = 0;
    const coveredChangeIds = new Set();

    for (const segment of segments) {
      const segmentStart = offset;
      const segmentEnd = offset + segment.text.length;
      offset = segmentEnd;

      if (segmentEnd <= start || segmentStart >= end) {
        continue;
      }

      for (const changeId of getSegmentChangeIds(segment)) {
        coveredChangeIds.add(changeId);
      }
    }

    return [...coveredChangeIds];
  }

  function extractSegmentsForRange(segments, start, end) {
    let offset = 0;
    const extractedSegments = [];

    for (const segment of segments) {
      const segmentStart = offset;
      const segmentEnd = offset + segment.text.length;
      offset = segmentEnd;

      if (segmentEnd <= start || segmentStart >= end) {
        continue;
      }

      const sliceStart = Math.max(start, segmentStart) - segmentStart;
      const sliceEnd = Math.min(end, segmentEnd) - segmentStart;
      extractedSegments.push(copySegment(segment, { text: segment.text.slice(sliceStart, sliceEnd) }));
    }

    return mergeAdjacentSegments(extractedSegments);
  }

  function replaceSegmentRange(segments, start, end, replacement) {
    let offset = 0;
    let inserted = false;
    const coveredChangeIds = getCoveredChangeIdsForRange(segments, start, end);
    const originalSegments = extractSegmentsForRange(segments, start, end);
    const nextSegments = [];

    for (const segment of segments) {
      const segmentStart = offset;
      const segmentEnd = offset + segment.text.length;
      offset = segmentEnd;

      if (segmentEnd <= start || segmentStart >= end) {
        nextSegments.push(copySegment(segment));
        continue;
      }

      if (start > segmentStart) {
        nextSegments.push(copySegment(segment, { text: segment.text.slice(0, start - segmentStart) }));
      }

      if (!inserted && (replacement || coveredChangeIds.length > 0 || originalSegments.length > 0)) {
        const manualSegment = {
          text: replacement,
          className: "token-manual-edit",
        };
        if (coveredChangeIds.length > 0) {
          manualSegment.changeIds = coveredChangeIds;
        }
        if (originalSegments.length > 0) {
          manualSegment.originalSegments = originalSegments;
        }
        nextSegments.push(manualSegment);
        inserted = true;
      }

      if (end < segmentEnd) {
        nextSegments.push(copySegment(segment, { text: segment.text.slice(end - segmentStart) }));
      }
    }

    return mergeAdjacentSegments(nextSegments);
  }

  function hasManualMergeSegments(segments) {
    return segments.some(isManualMergeSegment);
  }

  function getCurrentSegmentsForChangeIds(changeIds) {
    return changeIds.flatMap((changeId) => {
      const block = getBlockById(changeId);
      if (!block) {
        return [];
      }
      const explicitSide = mergeSelections[changeId];
      const selectedSide = explicitSide || "left";
      const text = getMergeTextForChoice(block, selectedSide);
      return [
        {
          text,
          className: explicitSide && text ? "token-merge" : "",
          changeId: block.id,
        },
      ];
    });
  }

  function getRestoreSegmentsForManualSegment(segment) {
    if (Array.isArray(segment.originalSegments) && segment.originalSegments.length > 0) {
      return segment.originalSegments.map((originalSegment) => copySegment(originalSegment));
    }

    return getCurrentSegmentsForChangeIds(getSegmentChangeIds(segment));
  }

  function cancelManualEditsInRange(segments, start, end) {
    let offset = 0;
    const nextSegments = [];

    for (const segment of segments) {
      const segmentStart = offset;
      const segmentEnd = offset + segment.text.length;
      offset = segmentEnd;

      if (!canCancelManualSegment(segment) || segmentEnd <= start || segmentStart >= end) {
        nextSegments.push(copySegment(segment));
        continue;
      }

      nextSegments.push(...getRestoreSegmentsForManualSegment(segment));
    }

    return applyMergeChoicesToSegments(mergeAdjacentSegments(nextSegments), mergeSelections);
  }

  function cancelSelectedManualEdit() {
    if (!selectedManualCancelRange) {
      return;
    }

    const nextSegments = cancelManualEditsInRange(
      currentMergeSegments,
      selectedManualCancelRange.start,
      selectedManualCancelRange.end,
    );
    manualMergeSegments = hasManualMergeSegments(nextSegments) ? nextSegments : null;
    renderMergeResult(currentBlocks);
    hideSelectionBadge();
    saveState();
  }

  function handleMergeDiffClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const manualEditElement = target ? target.closest("[data-manual-edit-index]") : null;
    if (!manualEditElement || !mergeActive) {
      return;
    }

    const segmentIndex = Number(manualEditElement.dataset.manualEditIndex);
    const manualCancelRange = getTextRangeForSegmentIndex(segmentIndex);
    if (!manualCancelRange || !manualCancelRange.text) {
      return;
    }

    window.setTimeout(() => {
      showSelectionBadge(
        countGraphemes(manualCancelRange.text),
        { x: event.clientX, y: event.clientY },
        {},
        null,
        manualCancelRange,
      );
    }, 0);
  }

  function editSelectedMergeText() {
    if (!selectedManualEditRange) {
      return;
    }

    const replacement = window.prompt("선택한 병합 결과를 수정하세요.", selectedManualEditRange.text);
    if (replacement === null) {
      return;
    }

    manualMergeSegments = replaceSegmentRange(
      currentMergeSegments,
      selectedManualEditRange.start,
      selectedManualEditRange.end,
      replacement,
    );
    renderMergeResult(currentBlocks);
    hideSelectionBadge();
    saveState();
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
    return copied;
  }

  async function copyTextToClipboard(text, button) {
    if (!text) {
      return;
    }

    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      } else {
        copied = fallbackCopyText(text);
      }
    } catch (_error) {
      copied = fallbackCopyText(text);
    }

    setCopyButtonLabel(button, copied ? "복사됨" : "복사 실패");
    window.setTimeout(() => {
      setCopyButtonLabel(button, "복사");
    }, 1400);
  }

  function copyMergeResult() {
    copyTextToClipboard(currentMergedText, dom.copyMergeResult);
  }

  function copyLeftText() {
    copyTextToClipboard(dom.leftText.value, dom.copyLeftText);
  }

  function copyRightText() {
    copyTextToClipboard(dom.rightText.value, dom.copyRightText);
  }

  function applySelectedMergeChoices() {
    if (Object.keys(selectedMergeChoices).length === 0) {
      return;
    }

    if (!mergeActive) {
      setMergeActive(true);
    }

    if (manualMergeSegments) {
      manualMergeSegments = applyMergeChoicesToSegments(currentMergeSegments, selectedMergeChoices);
    }
    mergeSelections = {
      ...mergeSelections,
      ...selectedMergeChoices,
    };
    renderDiff(dom.leftText.value, dom.rightText.value);
    saveState();
  }

  function renderDiff(leftText, rightText) {
    hideSelectionBadge();
    updateDiffCounters(leftText, rightText);

    const leftTokens = tokenize(leftText);
    const rightTokens = tokenize(rightText);
    const blocks = buildBlocks(lcsDiff(leftTokens, rightTokens));
    currentBlocks = blocks;

    dom.leftDiff.textContent = "";
    dom.rightDiff.textContent = "";

    if (!leftText && !rightText) {
      dom.leftDiff.textContent = "비교할 텍스트를 입력하세요.";
      dom.leftDiff.classList.add("empty");
      dom.rightDiff.textContent = "비교 결과가 여기에 표시됩니다.";
      dom.rightDiff.classList.add("empty");
      renderMergeResult(currentBlocks);
      return;
    }

    dom.leftDiff.classList.remove("empty");
    dom.rightDiff.classList.remove("empty");

    const leftFragment = document.createDocumentFragment();
    const rightFragment = document.createDocumentFragment();

    for (const block of blocks) {
      if (block.type === "equal") {
        appendText(leftFragment, block.text);
        appendText(rightFragment, block.text);
      } else {
        appendDiffChoice(leftFragment, block, "left");
        appendDiffChoice(rightFragment, block, "right");
      }
    }

    dom.leftDiff.appendChild(leftFragment);
    dom.rightDiff.appendChild(rightFragment);
    renderMergeResult(currentBlocks);
  }

  function scheduleDiffRender() {
    if (diffDebounceId) {
      window.clearTimeout(diffDebounceId);
    }
    diffDebounceId = window.setTimeout(() => {
      renderDiff(dom.leftText.value, dom.rightText.value);
    }, 130);
  }

  function swapTextInputs() {
    const leftValue = dom.leftText.value;
    dom.leftText.value = dom.rightText.value;
    dom.rightText.value = leftValue;
    resetMergeSelections();
    resetManualMergeEdits();
    autoResizeTextarea(dom.leftText);
    autoResizeTextarea(dom.rightText);
    renderDiff(dom.leftText.value, dom.rightText.value);
    saveState();
  }

  function handleDiffChoiceClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const choice = target ? target.closest(".diff-choice") : null;
    if (!choice || !mergeActive) {
      return;
    }
    selectMergeChoice(choice.dataset.changeId, choice.dataset.side);
  }

  function handleDiffChoiceKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const choice = target ? target.closest(".diff-choice") : null;
    if (!choice || !mergeActive) {
      return;
    }
    event.preventDefault();
    selectMergeChoice(choice.dataset.changeId, choice.dataset.side);
  }

  function bindSelectionCountEvents() {
    dom.applySelectionToMerge.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    dom.applySelectionToMerge.addEventListener("click", applySelectedMergeChoices);
    dom.editMergeSelection.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    dom.editMergeSelection.addEventListener("click", editSelectedMergeText);
    dom.cancelManualEdit.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    dom.cancelManualEdit.addEventListener("click", cancelSelectedManualEdit);
    document.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && event.target.closest("#selectionCountBadge")) {
        return;
      }
      rememberSelectionPointer(event);
    });
    document.addEventListener("pointermove", (event) => {
      if (event.buttons !== 1) {
        return;
      }
      rememberSelectionPointer(event);
      updateSelectionCountBadge();
    });
    document.addEventListener("pointerup", (event) => {
      rememberSelectionPointer(event);
      window.setTimeout(updateSelectionCountBadge, 0);
    });
    document.addEventListener("selectionchange", () => {
      window.setTimeout(updateSelectionCountBadge, 0);
    });
    document.addEventListener("keyup", () => {
      selectionPointer = null;
      updateSelectionCountBadge();
    });
    window.addEventListener("scroll", updateSelectionCountBadge, true);
  }

  function bindEvents() {
    dom.countInput.addEventListener("input", () => {
      autoResizeTextarea(dom.countInput);
      updateCounter();
      saveState();
    });
    for (const input of bracketOptionInputs) {
      input.addEventListener("change", () => {
        updateCounter();
        saveState();
      });
    }

    dom.leftText.addEventListener("input", () => {
      autoResizeTextarea(dom.leftText);
      resetMergeSelections();
      resetManualMergeEdits();
      scheduleDiffRender();
      saveState();
    });
    dom.rightText.addEventListener("input", () => {
      autoResizeTextarea(dom.rightText);
      resetMergeSelections();
      resetManualMergeEdits();
      scheduleDiffRender();
      saveState();
    });
    dom.compareNow.addEventListener("click", () => {
      if (diffDebounceId) {
        window.clearTimeout(diffDebounceId);
      }
      renderDiff(dom.leftText.value, dom.rightText.value);
      saveState();
    });
    dom.copyLeftText.addEventListener("click", copyLeftText);
    dom.copyRightText.addEventListener("click", copyRightText);
    dom.swapTexts.addEventListener("click", swapTextInputs);
    dom.copyMergeResult.addEventListener("click", copyMergeResult);
    dom.mergeDiff.addEventListener("click", handleMergeDiffClick);
    dom.startMerge.addEventListener("click", () => {
      resetMergeSelections();
      resetManualMergeEdits();
      setMergeActive(true);
      renderDiff(dom.leftText.value, dom.rightText.value);
      saveState();
    });
    dom.leftDiff.addEventListener("click", handleDiffChoiceClick);
    dom.rightDiff.addEventListener("click", handleDiffChoiceClick);
    dom.leftDiff.addEventListener("keydown", handleDiffChoiceKeydown);
    dom.rightDiff.addEventListener("keydown", handleDiffChoiceKeydown);
    bindSelectionCountEvents();
  }

  function init() {
    restoreState();
    bindEvents();
    resizeAllTextareas();
    window.addEventListener("resize", resizeAllTextareas);
    updateCounter();
    renderDiff(dom.leftText.value, dom.rightText.value);
  }

  init();
})();
