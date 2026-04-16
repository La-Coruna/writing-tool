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
  };

  let diffDebounceId = null;
  let storageEnabled = true;
  let mergeActive = false;
  let mergeSelections = {};
  let currentBlocks = [];
  let currentMergedText = "";
  let selectionPointer = null;
  let selectedMergeChoices = {};
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
  }

  function showSelectionBadge(count, position, mergeChoices) {
    const hasMergeChoices = Object.keys(mergeChoices).length > 0;
    selectedMergeChoices = mergeChoices;
    dom.selectionCountText.textContent = `${formatCount(count)}자`;
    dom.applySelectionToMerge.disabled = !hasMergeChoices;
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

    if (selectedCount === 0) {
      hideSelectionBadge();
      return;
    }

    showSelectionBadge(selectedCount, getSelectionBadgePosition(selection), mergeChoices);
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
      updateMergeCounter("");
      updateCopyMergeButton();
      return;
    }

    dom.mergeDiff.textContent = "";

    if (blocks.length === 0) {
      currentMergedText = "";
      dom.mergeDiff.textContent = "병합할 텍스트를 입력하세요.";
      dom.mergeDiff.classList.add("empty");
      updateMergeCounter("");
      updateCopyMergeButton();
      return;
    }

    dom.mergeDiff.classList.remove("empty");

    const fragment = document.createDocumentFragment();
    let mergedText = "";

    for (const block of blocks) {
      if (block.type === "equal") {
        appendText(fragment, block.text);
        mergedText += block.text;
        continue;
      }

      const explicitSide = mergeSelections[block.id];
      const selectedSide = explicitSide || "left";
      const text = getMergeTextForChoice(block, selectedSide);
      appendText(fragment, text, explicitSide && text ? "token-merge" : "");
      mergedText += text;
    }

    dom.mergeDiff.appendChild(fragment);
    currentMergedText = mergedText;
    updateMergeCounter(mergedText);
    updateCopyMergeButton();
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
    mergeSelections[changeId] = side;
    renderDiff(dom.leftText.value, dom.rightText.value);
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
      scheduleDiffRender();
      saveState();
    });
    dom.rightText.addEventListener("input", () => {
      autoResizeTextarea(dom.rightText);
      resetMergeSelections();
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
    dom.startMerge.addEventListener("click", () => {
      resetMergeSelections();
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
