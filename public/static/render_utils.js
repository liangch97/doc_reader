(function() {
  'use strict';

  // ==========================================
  // Emoji → Lucide icon mapping
  // Keys with \uFE0F handle variation selector variants
  // ==========================================
  var emojiMap = {
    '\uD83D\uDCDD': 'pencil',
    '\uD83D\uDCC4': 'file-text',
    '\uD83D\uDCC3': 'file-text',
    '\uD83D\uDD11': 'key-round',
    '\uD83D\uDDDD\uFE0F': 'key-round',
    '\uD83D\uDDDD': 'key-round',
    '\uD83D\uDCA1': 'lightbulb',
    '\u2705': 'check-circle',
    '\u2611\uFE0F': 'check-circle',
    '\u2611': 'check-circle',
    '\u274C': 'x-circle',
    '\u26A1': 'zap',
    '\u2B50': 'star',
    '\uD83C\uDF1F': 'star',
    '\uD83D\uDCCC': 'pin',
    '\uD83D\uDD0D': 'search',
    '\uD83D\uDD0E': 'search',
    '\uD83D\uDCCA': 'bar-chart-2',
    '\uD83D\uDCC8': 'trending-up',
    '\uD83C\uDFAF': 'target',
    '\uD83D\uDD17': 'link',
    '\uD83D\uDCD6': 'book-open',
    '\uD83D\uDCDA': 'book-open',
    '\uD83D\uDCAC': 'message-circle',
    '\u26A0\uFE0F': 'alert-triangle',
    '\u26A0': 'alert-triangle',
    '\u2139\uFE0F': 'info',
    '\u2139': 'info',
    '\uD83D\uDD50': 'clock',
    '\u23F0': 'clock',
    '\uD83D\uDDC2\uFE0F': 'folder',
    '\uD83D\uDDC2': 'folder',
    '\uD83D\uDCC1': 'folder',
    '\u2753': 'help-circle',
    '\uD83D\uDD25': 'flame',
    '\uD83D\uDCAD': 'message-square',
    '\u27A1\uFE0F': 'arrow-right',
    '\u27A1': 'arrow-right',
    '\u2192': 'arrow-right',
    '\u2B05\uFE0F': 'arrow-left',
    '\u2B05': 'arrow-left',
    '\u2190': 'arrow-left',
    '\uD83C\uDFF7\uFE0F': 'tag',
    '\uD83C\uDFF7': 'tag',
    '\uD83D\uDCCB': 'clipboard',
    '\uD83E\uDDE0': 'brain',
    '\uD83C\uDF93': 'graduation-cap',
    '\uD83D\uDD2C': 'microscope',
    '\uD83D\uDCBB': 'monitor',
    '\uD83C\uDF10': 'globe',
    '\uD83D\uDD04': 'refresh-cw',
    '\uD83D\uDCD0': 'ruler',
    '\u2728': 'sparkles',
    '\uD83C\uDFB5': 'music',
    '\uD83C\uDFB6': 'music',
    '\uD83D\uDCB0': 'dollar-sign',
    '\uD83D\uDCB5': 'dollar-sign',
    '\u2764\uFE0F': 'heart',
    '\u2764': 'heart',
    '\u2665\uFE0F': 'heart',
    '\u2665': 'heart',
    '\uD83D\uDD12': 'lock',
    '\uD83D\uDD13': 'unlock',
    '\u270F\uFE0F': 'edit',
    '\u270F': 'edit',
    '\uD83D\uDDD1\uFE0F': 'trash-2',
    '\uD83D\uDDD1': 'trash-2',
    '\uD83D\uDCE4': 'upload',
    '\uD83D\uDCE5': 'download',
    '\uD83C\uDFE0': 'home',
    '\u2699\uFE0F': 'settings',
    '\u2699': 'settings',
    '\uD83D\uDCF1': 'smartphone',
    '\uD83D\uDDA5\uFE0F': 'monitor',
    '\uD83D\uDDA5': 'monitor',
    '\uD83D\uDD14': 'bell',
    '\u2601\uFE0F': 'cloud',
    '\u2601': 'cloud'
  };

  // Build icon span HTML
  function makeIconSpan(iconName) {
    return '<span class="note-icon" data-lucide="' + iconName + '" ' +
      'style="width:16px;height:16px;display:inline-flex;vertical-align:-2px;' +
      'color:var(--primary);margin-right:3px;"></span>';
  }

  // Build a single regex from all emoji keys
  // Sort by length descending so longer sequences (with FE0F) match first
  var emojiKeys = Object.keys(emojiMap).sort(function(a, b) {
    return b.length - a.length;
  });

  var escapedKeys = emojiKeys.map(function(key) {
    return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });

  var emojiRegex = new RegExp('(' + escapedKeys.join('|') + ')', 'g');

  // ==========================================
  // replaceEmojiWithIcons
  // Splits HTML by tags, only replaces in text segments
  // ==========================================
  function replaceEmojiWithIcons(html) {
    if (!html) return html;
    var parts = html.split(/(<[^>]*>)/);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i].charAt(0) !== '<') {
        parts[i] = parts[i].replace(emojiRegex, function(match) {
          var iconName = emojiMap[match];
          return iconName ? makeIconSpan(iconName) : match;
        });
      }
    }
    return parts.join('');
  }

  // ==========================================
  // processFlashcards
  // Detects <strong>正面：</strong> / <strong>背面：</strong> patterns
  // ==========================================
  function processFlashcards(html) {
    if (!html) return html;

    var frontPattern = /<strong>正面[：:]<\/strong>/g;
    var backPattern = /<strong>背面[：:]<\/strong>/g;

    var frontMatches = [];
    var backMatches = [];
    var m;

    while ((m = frontPattern.exec(html)) !== null) {
      frontMatches.push({ index: m.index, length: m[0].length });
    }
    while ((m = backPattern.exec(html)) !== null) {
      backMatches.push({ index: m.index, length: m[0].length });
    }

    if (frontMatches.length === 0) return html;

    var pairs = [];
    for (var i = 0; i < frontMatches.length; i++) {
      var front = frontMatches[i];
      var back = null;
      for (var j = 0; j < backMatches.length; j++) {
        if (backMatches[j].index > front.index) {
          back = backMatches[j];
          break;
        }
      }
      if (back) {
        pairs.push({ front: front, back: back });
      }
    }

    for (var k = pairs.length - 1; k >= 0; k--) {
      var pair = pairs[k];
      var frontEnd = pair.front.index + pair.front.length;
      var backEnd = pair.back.index + pair.back.length;

      var nextFrontIdx = html.length;
      if (k < pairs.length - 1) {
        nextFrontIdx = pairs[k + 1].front.index;
      }

      var backContent = html.substring(backEnd, nextFrontIdx).trim();
      var frontContent = html.substring(frontEnd, pair.back.index).trim();

      var replacement = '<div class="flashcard-front">' + frontContent + '</div>' +
        '<div class="flashcard-back">' + backContent + '</div>';

      html = html.substring(0, pair.front.index) + replacement +
        html.substring(nextFrontIdx);
    }

    return html;
  }

  // ==========================================
  // processQA
  // Detects <strong>Q：</strong> / <strong>A：</strong> patterns
  // ==========================================
  function processQA(html) {
    if (!html) return html;

    var qPattern = /<strong>Q[：:]<\/strong>/g;
    var aPattern = /<strong>A[：:]<\/strong>/g;

    var qMatches = [];
    var aMatches = [];
    var m;

    while ((m = qPattern.exec(html)) !== null) {
      qMatches.push({ index: m.index, length: m[0].length });
    }
    while ((m = aPattern.exec(html)) !== null) {
      aMatches.push({ index: m.index, length: m[0].length });
    }

    if (qMatches.length === 0) return html;

    var pairs = [];
    for (var i = 0; i < qMatches.length; i++) {
      var q = qMatches[i];
      var a = null;
      for (var j = 0; j < aMatches.length; j++) {
        if (aMatches[j].index > q.index) {
          a = aMatches[j];
          break;
        }
      }
      if (a) {
        pairs.push({ q: q, a: a });
      }
    }

    for (var k = pairs.length - 1; k >= 0; k--) {
      var pair = pairs[k];
      var qEnd = pair.q.index + pair.q.length;
      var aEnd = pair.a.index + pair.a.length;

      var nextQIdx = html.length;
      if (k < pairs.length - 1) {
        nextQIdx = pairs[k + 1].q.index;
      }

      var aContent = html.substring(aEnd, nextQIdx).trim();
      var qContent = html.substring(qEnd, pair.a.index).trim();

      var replacement = '<div class="qa-question">' + qContent + '</div>' +
        '<div class="qa-answer">' + aContent + '</div>';

      html = html.substring(0, pair.q.index) + replacement +
        html.substring(nextQIdx);
    }

    return html;
  }

  // ==========================================
  // processCornell
  // Detects h3 headings: 关键词 / 笔记 / 总结
  // ==========================================
  function processCornell(html) {
    if (!html) return html;

    var headingPattern = /<h3[^>]*>(关键词|笔记|总结)<\/h3>/g;
    var matches = [];
    var m;

    while ((m = headingPattern.exec(html)) !== null) {
      matches.push({ index: m.index, length: m[0].length, type: m[1] });
    }

    if (matches.length === 0) return html;

    var classMap = {
      '关键词': 'cornell-keywords',
      '笔记': 'cornell-notes',
      '总结': 'cornell-summary'
    };

    for (var i = matches.length - 1; i >= 0; i--) {
      var match = matches[i];
      var start = match.index;
      var contentStart = match.index + match.length;
      var end = (i < matches.length - 1) ? matches[i + 1].index : html.length;
      var content = html.substring(contentStart, end);
      var className = classMap[match.type];

      var replacement = '<div class="' + className + '">' +
        '<h3>' + match.type + '</h3>' + content + '</div>';

      html = html.substring(0, start) + replacement + html.substring(end);
    }

    return html;
  }

  // ==========================================
  // escapeHtml
  // ==========================================
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ==========================================
  // processMindmap
  // Converts h1 + h2 + ul/li structure into a visual tree
  // ==========================================
  function processMindmap(html) {
    if (!html) return html;
    // Must contain at least one h1 and one h2
    if (html.indexOf('<h1') === -1 || html.indexOf('<h2') === -1) return html;

    var container = document.createElement('div');
    container.innerHTML = html;
    var h1 = container.querySelector('h1');
    var h2s = container.querySelectorAll('h2');
    if (!h1 || h2s.length < 2) return html;

    var out = '<div class="mindmap-tree">';
    out += '<div class="mm-root">' + h1.innerHTML + '</div>';
    out += '<div class="mm-branches">';

    // Collect each h2 + following content (ul/ol items AND other block elements)
    for (var i = 0; i < h2s.length; i++) {
      var branch = h2s[i];
      var items = [];
      var extraHtml = '';
      var next = branch.nextElementSibling;
      while (next && next.tagName !== 'H2' && next.tagName !== 'H1') {
        if (next.tagName === 'UL' || next.tagName === 'OL') {
          var lis = next.querySelectorAll('li');
          for (var j = 0; j < lis.length; j++) {
            items.push(lis[j].innerHTML);
          }
        } else {
          // Capture non-list content: paragraphs, tables, blockquotes, etc.
          extraHtml += next.outerHTML;
        }
        next = next.nextElementSibling;
      }
      out += '<div class="mm-branch">';
      out += '<div class="mm-branch-label">' + branch.innerHTML + '</div>';
      if (items.length > 0 || extraHtml) {
        out += '<div class="mm-leaves">';
        for (var k = 0; k < items.length; k++) {
          out += '<div class="mm-leaf">' + items[k] + '</div>';
        }
        if (extraHtml) {
          out += '<div class="mm-leaf mm-leaf-block">' + extraHtml + '</div>';
        }
        out += '</div>';
      }
      out += '</div>';
    }

    out += '</div></div>';
    return out;
  }

  // ==========================================
  // processConceptMap
  // Converts **A** —[rel]→ **B** patterns into visual graph
  // ==========================================
  function processConceptMap(html) {
    if (!html) return html;
    // Match patterns like: <strong>X</strong> —[rel]→ <strong>Y</strong>
    // or X → Y style arrows, at least 2 relations needed
    var relPattern = /<strong>([^<]+)<\/strong>\s*[\u2014\u2013\-]+\s*\[?([^\]\u2192]*)\]?\s*\u2192\s*<strong>([^<]+)<\/strong>/g;
    var relations = [];
    var m;
    while ((m = relPattern.exec(html)) !== null) {
      relations.push({ from: m[1].trim(), rel: m[2].trim(), to: m[3].trim() });
    }
    if (relations.length < 2) return html;

    // Collect unique concepts
    var conceptSet = {};
    for (var i = 0; i < relations.length; i++) {
      conceptSet[relations[i].from] = true;
      conceptSet[relations[i].to] = true;
    }
    var concepts = Object.keys(conceptSet);

    var out = '<div class="concept-map">';
    out += '<div class="cm-nodes">';
    for (var c = 0; c < concepts.length; c++) {
      out += '<span class="cm-node" data-concept="' + escapeHtml(concepts[c]) + '">' + escapeHtml(concepts[c]) + '</span>';
    }
    out += '</div>';
    out += '<div class="cm-edges">';
    for (var r = 0; r < relations.length; r++) {
      out += '<div class="cm-edge">';
      out += '<span class="cm-from">' + escapeHtml(relations[r].from) + '</span>';
      out += '<span class="cm-arrow">';
      if (relations[r].rel) {
        out += '<span class="cm-rel">' + escapeHtml(relations[r].rel) + '</span>';
      }
      out += '<svg width="24" height="12" viewBox="0 0 24 12"><path d="M0 6h18M14 1l6 5-6 5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
      out += '</span>';
      out += '<span class="cm-to">' + escapeHtml(relations[r].to) + '</span>';
      out += '</div>';
    }
    out += '</div>';

    // Keep any trailing paragraph as summary (text after all relations)
    // Find last relation match position
    relPattern.lastIndex = 0;
    var lastMatch = null;
    while ((m = relPattern.exec(html)) !== null) { lastMatch = m; }
    if (lastMatch) {
      var afterIdx = lastMatch.index + lastMatch[0].length;
      var tail = html.substring(afterIdx).replace(/^\s*<\/p>/i, '').trim();
      // Remove leading empty <p></p> or <br>
      tail = tail.replace(/^(<br\s*\/?>|\s)*/gi, '').trim();
      if (tail.length > 10 && /<p>/i.test(tail)) {
        out += '<div class="cm-summary">' + tail + '</div>';
      }
    }

    out += '</div>';
    return out;
  }

  // ==========================================
  // processFlashcardsEnhanced
  // Wraps flashcard pairs into flippable cards separated by ---
  // ==========================================
  function processFlashcardsEnhanced(html) {
    // First run the original processor
    html = processFlashcards(html);
    if (html.indexOf('flashcard-front') === -1) return html;

    // Wrap consecutive front+back pairs into card containers
    // Split by <hr> which comes from ---
    html = html.replace(/<hr\s*\/?>/g, '<!--card-sep-->');
    var parts = html.split('<!--card-sep-->');
    var out = '<div class="flashcard-deck">';
    var cardNum = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf('flashcard-front') > -1) {
        cardNum++;
        out += '<div class="flashcard-card" data-flipped="false">';
        out += '<div class="flashcard-num">' + cardNum + '</div>';
        out += p;
        out += '<button class="flashcard-flip-btn">翻转</button>';
        out += '</div>';
      } else if (p) {
        out += p;
      }
    }
    out += '</div>';
    return out;
  }

  // ==========================================
  // renderMarkdown — main rendering pipeline
  // ==========================================
  function renderMarkdown(text) {
    if (!text) return '';
    try {
      if (window.marked) {
        if (window.hljs) {
          marked.setOptions({
            highlight: function(code, lang) {
              if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
              }
              return hljs.highlightAuto(code).value;
            }
          });
        }
        marked.setOptions({ breaks: true, gfm: true });
        var html = marked.parse(text);
        html = replaceEmojiWithIcons(html);
        html = processFlashcardsEnhanced(html);
        html = processQA(html);
        html = processCornell(html);
        html = processMindmap(html);
        html = processConceptMap(html);
        return html;
      }
    } catch (e) {
      console.error('renderMarkdown error:', e);
    }
    return '<pre>' + escapeHtml(text) + '</pre>';
  }

  // ==========================================
  // postProcessMarkdown — DOM post-processing
  // ==========================================
  function postProcessMarkdown(el) {
    if (!el) return;

    if (window.lucide) {
      try {
        lucide.createIcons({ attrs: { class: 'note-icon' } });
      } catch (e) {
        console.error('lucide.createIcons error:', e);
      }
    }

    if (window.renderMathInElement) {
      try {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false }
          ],
          throwOnError: false
        });
      } catch (e) {
        console.error('renderMathInElement error:', e);
      }
    }

    if (window.Heti) {
      try {
        var heti = new Heti('.heti');
        heti.autoSpacing();
      } catch (e) {
        console.error('Heti error:', e);
      }
    }

    // Flashcard flip interaction
    var flipBtns = el.querySelectorAll('.flashcard-flip-btn');
    for (var i = 0; i < flipBtns.length; i++) {
      flipBtns[i].addEventListener('click', function () {
        var card = this.closest('.flashcard-card');
        if (!card) return;
        var flipped = card.getAttribute('data-flipped') === 'true';
        card.setAttribute('data-flipped', flipped ? 'false' : 'true');
        this.textContent = flipped ? '翻转' : '收起';
      });
    }
  }

  // ==========================================
  // Expose public API
  // ==========================================
  window.RenderUtils = {
    renderMarkdown: renderMarkdown,
    postProcessMarkdown: postProcessMarkdown,
    replaceEmojiWithIcons: replaceEmojiWithIcons,
    escapeHtml: escapeHtml
  };

})();
