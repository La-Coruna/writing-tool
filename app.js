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
    leftText: document.getElementById("leftText"),
    rightText: document.getElementById("rightText"),
    leftCountWithSpace: document.getElementById("leftCountWithSpace"),
    leftCountWithoutSpace: document.getElementById("leftCountWithoutSpace"),
    rightCountWithSpace: document.getElementById("rightCountWithSpace"),
    rightCountWithoutSpace: document.getElementById("rightCountWithoutSpace"),
    leftDiff: document.getElementById("leftDiff"),
    rightDiff: document.getElementById("rightDiff"),
  };

  let diffDebounceId = null;
  let storageEnabled = true;
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

  function saveState() {
    if (!storageEnabled) {
      return;
    }
    const state = {
      countInput: dom.countInput.value,
      excludedBracketTypes: getExcludedBracketTypes(),
      leftText: dom.leftText.value,
      rightText: dom.rightText.value,
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

      if (deleted && inserted) {
        blocks.push({ type: "replace", left: deleted, right: inserted });
      } else if (deleted) {
        blocks.push({ type: "delete", left: deleted });
      } else if (inserted) {
        blocks.push({ type: "insert", right: inserted });
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

  function renderDiff(leftText, rightText) {
    updateDiffCounters(leftText, rightText);

    const leftTokens = tokenize(leftText);
    const rightTokens = tokenize(rightText);
    const blocks = buildBlocks(lcsDiff(leftTokens, rightTokens));

    dom.leftDiff.textContent = "";
    dom.rightDiff.textContent = "";

    if (!leftText && !rightText) {
      dom.leftDiff.textContent = "비교할 텍스트를 입력하세요.";
      dom.leftDiff.classList.add("empty");
      dom.rightDiff.textContent = "비교 결과가 여기에 표시됩니다.";
      dom.rightDiff.classList.add("empty");
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
      } else if (block.type === "delete") {
        appendText(leftFragment, block.left, "token-delete");
      } else if (block.type === "insert") {
        appendText(rightFragment, block.right, "token-insert");
      } else if (block.type === "replace") {
        appendText(leftFragment, block.left, "token-replace-left");
        appendText(rightFragment, block.right, "token-replace-right");
      }
    }

    dom.leftDiff.appendChild(leftFragment);
    dom.rightDiff.appendChild(rightFragment);
  }

  function scheduleDiffRender() {
    if (diffDebounceId) {
      window.clearTimeout(diffDebounceId);
    }
    diffDebounceId = window.setTimeout(() => {
      renderDiff(dom.leftText.value, dom.rightText.value);
    }, 130);
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
      scheduleDiffRender();
      saveState();
    });
    dom.rightText.addEventListener("input", () => {
      autoResizeTextarea(dom.rightText);
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
