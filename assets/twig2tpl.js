/**
 * Twig2TPL — конвертер twig → PHP-шаблоны (.tpl) для OpenCart 2.x.
 * Версия: 0.13. Политика: версия повышается при каждой правке или
 * расширении функционала конвертера (формат 0.xx до стабилизации 1.0).
 * Ядро, перенос которого проверено на реальном порту модуля llms_generator
 * (OC 3 → OC 2.3.0.2). Работает целиком в браузере, без сети.
 *
 * Поддерживает (в отличие от онлайн-аналогов, проверено тестами):
 *   - {{ var }}, {{ a.b }}, {{ a.b.c }}, {{ a['b'] }}
 *   - {% if %} / {% elseif %} / {% else %} / {% endif %}, {% for %} / {% endfor %}
 *   - {% set x = литерал | массив | число | переменная %}
 *   - конкатенация `~`, тернарник, сравнения (не теряют $ у операндов)
 *   - {{ x|e('js') }} / |e("js") → llms_js_escape() (addslashes + экранирование \r\n\v\f\0), |escape('js')
 *   - {{ 'fmt'|format(...) }} → sprintf() + автосчётчики loop.index / loop.index0
 *   - |length → count(), |trim, |upper, |lower, |striptags, |raw
 *   - |escape('html') / |e('html_attr') → htmlspecialchars(ENT_QUOTES, 'UTF-8'), |nl2br,
 *     |json_encode, |slice(a,b) → mb_substr, |default(v) → !empty()-тернарник,
 *     |date / |date_modify → date()/strtotime()
 *   - {{ attribute(_context, 'tab_' ~ key) }} → ${'tab_' . $key} с isset-гвардом
 *   - `x is defined` → isset(), `x is not empty` → !empty(), `x is empty` → empty(),
 *     `x in [...]` → in_array(), `not`/`and`/`or` → !/&&/||
 *   - тернарники в echo: `a ? b : c`, `a ? b` (без ':'), elvis `a ?: b`
 *   - {% for k, v in coll %} (с ключом), {% for x in range(a, b) %} и `a..b`
 *   - {% set x = { 'k': expr, ... } %} (twig-словарь, в т.ч. многострочный)
 *   - twig-комментарии {# ... #} удаляются
 *   - числовые литералы в условиях НЕ превращаются в $N (баг ранних версий)
 *   - user_token → token (опционально)
 * Нераспознанные конструкции не ломают вывод: проходят насквозь и попадают
 * в список предупреждений.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Twig2TPL = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.13';

  var KEYWORDS = ['and', 'or', 'not', 'true', 'false', 'null', 'in', 'is',
    'defined', 'empty', 'divisible', 'contains', 'starts', 'ends', 'matches', 'same'];

  function isKeyword(w) { return KEYWORDS.indexOf(w) !== -1; }

  /* ---- защита строковых литералов от подстановок ----
   * Токены содержат уникальный id вызова: вложенные вызовы не съедают
   * чужие маркеры и не превращают их в undefined (реальный баг порта ex_reviews).
   */
  var protectSeq = 0;
  function protectStrings(s) {
    var store = [];
    var callId = ++protectSeq;
    var out = s.replace(/'[^']*'|"[^"]*"/g, function (m) {
      store.push(m);
      return '\u0000' + callId + ':' + (store.length - 1) + '\u0000';
    });
    return { s: out, restore: function (x) {
      return x.replace(new RegExp('\u0000' + callId + ':(\\d+)\u0000', 'g'),
        function (_, i) { return store[+i]; });
    }, callId: callId };
  }

  /* ---- 'a' ~ key ~ 'b'  →  'a' . $key . 'b' ---- */
  function buildConcat(inner) {
    var parts = inner.split('~').map(function (p) { return p.trim(); })
      .filter(function (p) { return p !== ''; });
    var out = [];
    parts.forEach(function (p) {
      if (p.charAt(0) === "'") { out.push(p); return; }
      // строковые литералы уже могли быть заменены маркерами протектора? нет:
      // buildConcat получает сырой текст. Но литералы с пробелами/подчёркиваниями
      // обязательны к сохранению как строки, не как имена переменных.
      if (/^'[\s\S]*'$/.test(p)) { out.push(p); return; }
      var b = convBaseExpr(p);
      out.push(b ? b.php : '$' + p);
    });
    return out.join(' . ');
  }

  /* ---- базовые выражения: слово, цепочка точек, скобка, литерал ---- */
  function convBaseExpr(e) {
    e = e.trim();
    if (/^\d+(\.\d+)?$/.test(e)) return { php: e };
    if (/^'[^']*'$/.test(e)) return { php: e };
    if (/^"[^"]*"$/.test(e)) return { php: e };
    var m = e.match(/^attribute\(_context,\s*([^(]+?)\)$/);
    if (m) return { php: '${' + segConcat(m[1]) + '}', guard: true };
    m = e.match(/^(\w+)((?:\.\w+)+)$/);
    if (m) {
      var segs = m[2].split('.').slice(1);
      var php = '$' + m[1];
      segs.forEach(function (s) { php += "['" + s + "']"; });
      return { php: php, guard: segs.length > 1 };
    }
    // a['b']['c'] — цепочка строковых индексов
    m = e.match(/^(\w+)((?:\['[^']+'\])+)$/);
    if (m) {
      var php2 = '$' + m[1];
      var rest2 = m[2];
      var rm2;
      while ((rm2 = rest2.match(/^\['([^']+)'\]/))) { php2 += "['" + rm2[1] + "']"; rest2 = rest2.slice(rm2[0].length); }
      if (rest2 === '') return { php: php2 };
    }
    m = e.match(/^(\w+)\['([^']+)'\]$/);
    if (m) return { php: '$' + m[1] + "['" + m[2] + "']" };
    // голое слово — но НЕ число и НЕ вызов функции (range(...), date(...))
    if (/^\w+$/.test(e) && !isKeyword(e)) return { php: '$' + e };
    return null;
  }

  /* ---- разрезание строки по верхнеуровневому разделителю (вне кавычек и скобок) ---- */
  function splitTop(s, sep) {
    var parts = [], depth = 0, cur = '', q = null;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && s.substr(i, sep.length) === sep) {
        parts.push(cur); cur = ''; i += sep.length - 1; continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts;
  }

  /* ---- позиция первого вхождения подстроки на нулевой глубине ---- */
  function findTop(s, needle) {
    var depth = 0, q = null;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; continue; }
      if (ch === '(' || ch === '[') { depth++; continue; }
      if (ch === ')' || ch === ']') { depth--; continue; }
      if (depth === 0 && s.substr(i, needle.length) === needle) return i;
    }
    return -1;
  }

  /* ---- выражение целиком обёрнуто в скобки: (a ? b : c) ---- */
  function isWrappedParens(s) {
    var depth = 0, q = null;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"') { q = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i === s.length - 1; }
    }
    return false;
  }

  /* ---- {{ ... }} ---- */
  function convEcho(inner, ctx, warnings) {
    inner = inner.trim();

    // пустой словарь {{ ... : {} }} → array()
    if (inner === '{}') return 'array()';

    // выражение целиком в скобках: (expr) — конвертируем содержимое
    if (inner.charAt(0) === '(' && isWrappedParens(inner)) {
      var unwrapped = convEcho(inner.slice(1, -1).trim(), ctx, warnings);
      if (unwrapped !== null) return '(' + unwrapped + ')';
    }

    // "now"|date_modify(...)|date(...) и "now"|date(...)
    var mNow = inner.match(/^"now"\s*\|\s*date_modify\(([\s\S]+)\)\s*\|\s*date\(([\s\S]+)\)$/);
    if (mNow) {
      var spec = convEcho(mNow[1].trim(), ctx, warnings);
      var fmt = convEcho(mNow[2].trim(), ctx, warnings);
      if (spec !== null && fmt !== null) return 'date(' + fmt + ', strtotime(' + spec + '))';
      return null;
    }
    var mNow2 = inner.match(/^"now"\s*\|\s*date\(([\s\S]+)\)$/);
    if (mNow2) {
      var f2 = convEcho(mNow2[1].trim(), ctx, warnings);
      if (f2 !== null) return 'date(' + f2 + ')';
      return null;
    }

    // elvis a ?: b (верхний уровень) — ДО тернарника: '?:' содержит '?'
    var eIdx = findTop(inner, '?:');
    if (eIdx !== -1) {
      var av = convEcho(inner.slice(0, eIdx).trim(), ctx, warnings);
      var bv = convEcho(inner.slice(eIdx + 2).trim(), ctx, warnings);
      if (av !== null && bv !== null) return '!empty(' + av + ') ? ' + av + ' : ' + bv;
      return null;
    }

    // тернарник верхнего уровня: ветки могут содержать пайплайны фильтров,
    // поэтому ветки конвертируются через convEcho рекурсивно
    var qIdx = findTop(inner, '?');
    if (qIdx !== -1 && inner[qIdx + 1] !== ':') {
      var cond = inner.slice(0, qIdx).trim();
      var rest = inner.slice(qIdx + 1).trim();
      var cIdx = findTop(rest, ':');
      // условие может содержать фильтры (text|length > 100) — сначала convEcho,
      // затем convCond (is defined, or/and/not)
      var cc = convEcho(cond, ctx, warnings);
      if (cc === null) cc = convCond(cond, warnings, ctx);
      if (cc === null) return null;
      if (cIdx !== -1) {
        var aa = convEcho(rest.slice(0, cIdx).trim(), ctx, warnings);
        var bb = convEcho(rest.slice(cIdx + 1).trim(), ctx, warnings);
        if (aa === null || bb === null) return null;
        return cc + ' ? ' + aa + ' : ' + bb;
      }
      var aa = convEcho(rest, ctx, warnings);
      if (aa === null) return null;
      return cc + ' ? ' + aa + " : ''";
    }

    var segs = splitTop(inner, '|');
    var base = segs[0].trim();
    var filters = segs.slice(1).map(function (f) { return f.trim(); });

    var v = convValue(base, ctx, warnings);
    if (v === null) return null;

    for (var i = 0; i < filters.length; i++) {
      var f = filters[i];
      var m = f.match(/^e\(\s*(['"])js\1\s*\)$/) || f.match(/^escape\(\s*(['"])js\1\s*\)$/);
      // |e('js') эквивалентен addslashes ТОЛЬКО пока в строке нет переносов:
      // addslashes не экранирует \n/\r, и сырой line break внутри JS-литерала
      // дает SyntaxError (реальный кейс: llms_generator, многострочный пример в lang-файле).
      // Полный PHP-эквивалент без изменения формы окружающего кода —
      // addslashes + доп. экранирование переводов строк и закрывающих кавычек-скобок.
      if (m) { v = 'llms_js_escape(' + v + ')'; continue; }
      if (f === 'raw') { continue; }
      if (f === 'length') { v = 'count(' + v + ')'; continue; }
      if (f === 'trim') { v = 'trim(' + v + ')'; continue; }
      if (f === 'upper') { v = 'strtoupper(' + v + ')'; continue; }
      if (f === 'lower') { v = 'strtolower(' + v + ')'; continue; }
      if (f === 'striptags') { v = 'strip_tags(' + v + ')'; continue; }
      m = f.match(/^(?:escape|e)\(\s*(['"])(?:html|html_attr)\1\s*\)$/);
      if (m) { v = "htmlspecialchars(" + v + ", ENT_QUOTES, 'UTF-8')"; continue; }
      if (f === 'nl2br') { v = 'nl2br(' + v + ')'; continue; }
      if (f === 'json_encode' || f === 'json_encode()') { v = 'json_encode(' + v + ')'; continue; }
      m = f.match(/^slice\(([^()]*)\)$/);
      if (m) {
        var sl = splitTop(m[1], ',').map(function (a) { return convEcho(a.trim(), ctx, warnings); });
        if (sl.length === 2 && !sl.some(function (a) { return a === null; })) {
          v = 'mb_substr(' + v + ', ' + sl[0] + ', ' + sl[1] + ')'; continue;
        }
      }
      m = f.match(/^default\(([\s\S]*)\)$/);
      if (m) {
        var dv = convEcho(m[1].trim(), ctx, warnings);
        if (v !== null && dv !== null) { v = '!empty(' + v + ') ? ' + v + ' : ' + dv; continue; }
        return null;
      }
      m = f.match(/^format\(([\s\S]*)\)$/);
      if (m) {
        var args = splitTop(m[1], ',').map(function (a) {
          return convValue(a.trim(), ctx, warnings);
        });
        if (args.some(function (a) { return a === null; })) return null;
        v = 'sprintf(' + v + ', ' + args.join(', ') + ')';
        base = '\u0001' + v + '\u0001'; // уже собрано, следующие фильтры оборачивают целиком
        continue;
      }
      // фильтр с хвостом-выражением: '> 100' (сравнение) или "~ '...'" (склейка)
      // реальный кейс ex_reviews: {{ text|length > 100 ? text|slice(0,70) ~ '...' : text }}
      var ft = f.match(/^([a-zA-Z_]\w*)(\([^\(\)]*\))?([\s\S]*)$/);
      if (ft && ft[3] && ft[3].trim() !== '') {
        var wrapped = applyFilterByName(ft[1], ft[2] ? ft[2].slice(1, -1) : null, v, ctx, warnings);
        if (wrapped === null) return null;
        var tailStr = ft[3].trim();
        if (/^~/.test(tailStr)) {
          // ветка заканчивается склейкой: (mb_substr(...) . '...')
          var rhs = convEcho(tailStr.replace(/^~\s*/, ''), ctx, warnings);
          if (rhs === null) return null;
          v = '(' + wrapped + ' . ' + rhs + ')';
          continue;
        }
        var tail = convCond(tailStr, warnings, ctx);
        if (tail === null) return null;
        v = '(' + wrapped + ' ' + tail + ')';
        continue;
      }
      warnings.push('фильтр |' + f + ' не поддержан — конструкция перенесена как есть');
      return null;
    }
    return v;
  }

  /* ---- применение фильтра по имени (для ветки с хвостом-выражением) ---- */
  function applyFilterByName(name, argsRaw, v, ctx, warnings) {
    var vv = v;
    switch (name) {
      case 'escape': case 'e':
        return "htmlspecialchars(" + vv + ", ENT_QUOTES, 'UTF-8')";
      case 'nl2br': return 'nl2br(' + vv + ')';
      case 'raw': return vv;
      case 'json_encode': return 'json_encode(' + vv + ')';
      case 'length': return 'count(' + vv + ')';
      case 'trim': return 'trim(' + vv + ')';
      case 'upper': return 'strtoupper(' + vv + ')';
      case 'lower': return 'strtolower(' + vv + ')';
      case 'striptags': return 'strip_tags(' + vv + ')';
      case 'default': {
        var dv = convEcho(String(argsRaw).trim(), ctx, warnings);
        return (dv === null || vv === null) ? null : '!empty(' + vv + ') ? ' + vv + ' : ' + dv;
      }
      case 'slice': {
        var sl = splitTop(String(argsRaw), ',').map(function (a) { return convEcho(a.trim(), ctx, warnings); });
        if (sl.length === 2 && !sl.some(function (a) { return a === null; })) {
          return 'mb_substr(' + vv + ', ' + sl[0] + ', ' + sl[1] + ')';
        }
        return null;
      }
      case 'format': {
        var args = splitTop(String(argsRaw), ',').map(function (a) {
          return convValue(a.trim(), ctx, warnings);
        });
        if (args.some(function (a) { return a === null; })) return null;
        return 'sprintf(' + vv + ', ' + args.join(', ') + ')';
      }
      default:
        return null;
    }
  }

  /* ---- значение: тернарник / конкатенация / базовое ---- */
  function convValue(e, ctx, warnings) {
    e = e.trim();
    // тернарник (верхнеуровневый ?)
    var tern = splitTop(e, '?');
    if (tern.length === 2) {
      var arms = splitTop(tern[1], ':');
      if (arms.length === 2) {
        var c = convCond(tern[0].trim(), warnings, ctx);
        var a = convValue(arms[0].trim(), ctx, warnings);
        var b = convValue(arms[1].trim(), ctx, warnings);
        if (c !== null && a !== null && b !== null) return c + ' ? ' + a + ' : ' + b;
        return null;
      }
    }
    if (e.indexOf('~') !== -1) {
      var parts = splitTop(e, '~').map(function (p) { return p.trim(); })
        .filter(function (p) { return p !== ''; });
      if (parts.length > 1) {
        var parts2 = parts.map(function (p) { return convValue(p, ctx, warnings); });
        if (parts2.some(function (p) { return p === null; })) return null;
        return parts2.join(' . ');
      }
    }
    // арифметика верхнего уровня: {{ key + 1 }}, {{ j - 1 }}
    var ap = splitTop(e, '+');
    if (ap.length === 2) {
      var ap0 = convValue(ap[0].trim(), ctx, warnings);
      var ap1 = convValue(ap[1].trim(), ctx, warnings);
      if (ap0 !== null && ap1 !== null) return ap0 + ' + ' + ap1;
    }
    var am2 = splitTop(e, '-');
    if (am2.length === 2) {
      var av4 = convValue(am2[0].trim(), ctx, warnings);
      var bv3 = convValue(am2[1].trim(), ctx, warnings);
      if (av4 !== null && bv3 !== null) return av4 + ' - ' + bv3;
    }
    // loop.index / loop.index0 внутри echo — через стек циклов
    var lmv = e.match(/^loop\.(\w+)$/);
    if (lmv) {
      var topLoop = null;
      for (var li = ctx.loopStack.length - 1; li >= 0; li--) {
        if (ctx.loopStack[li] && ctx.loopStack[li].iter) { topLoop = ctx.loopStack[li]; break; }
      }
      if (topLoop && lmv[1] === 'index') return '$' + topLoop.iter + '_index';
      if (topLoop && lmv[1] === 'index0') return '($' + topLoop.iter + '_index - 1)';
      if (topLoop && lmv[1] === 'first') return '($' + topLoop.iter + '_index === 1)';
      warnings.push('loop.' + lmv[1] + ' вне цикла for — конструкция перенесена как есть');
      return null;
    }
    var b = convBaseExpr(e);
    if (b) {
      if (b.guard && ctx.issetGuard) {
        return "(isset(" + b.php + ") ? " + b.php + " : '')";
      }
      return b.php;
    }
    // путь с индексами: ex_reviews['seo_url'][store.store_id][language.language_id]
    if (/^\{\}$/.test(e)) return 'array()';
    var p = convPathExpr(e);
    if (p !== null) return p;
    // loop.* внутри echo обрабатывается через контекст цикла
    var lm = e.match(/^loop\.(\w+)$/);
    if (lm && ctx.loopVar) {
      if (lm[1] === 'index') return '$' + ctx.loopVar + '_index';
      if (lm[1] === 'index0') return '($' + ctx.loopVar + '_index - 1)';
      warnings.push('loop.' + lm[1] + ' не поддержан');
      return null;
    }
    return null;
  }

  /* ---- склейка сегментов '~' c учётом строковых маркеров протектора ---- */
  function segConcat(inner) {
    var parts = inner.split('~').map(function (p) { return p.trim(); })
      .filter(function (p) { return p !== ''; });
    var segs = parts.map(function (p) {
      // маркер строки-протектора или обычный литерал — оставить как есть
      if (/^\u0000\d+\u0000$/.test(p) || /^'/.test(p) || /^\d/.test(p)) return p;
      var b = convBaseExpr(p);
      return b ? b.php : '$' + p;
    });
    return segs.join(' . ');
  }

  /* ---- условия {% if %} / {% elseif %} ---- */
  function convCond(c, warnings, ctx) {
    var prot = protectStrings(c);
    var s = prot.s;

    // защита in_array/array/isset/empty от повторной обработки ниже
    var marks = [];
    function mark(x) { marks.push(x); return '\u0002' + (marks.length - 1) + '\u0002'; }

    // twig loop.* → счётчик итераций: loop.first → ($iter_index === 1),
    // loop.index → $iter_index, loop.index0 → ($iter_index - 1)
    s = s.replace(/\bloop\.(index0|index|first)\b/g, function (m0, w) {
      var top = null;
      if (ctx && ctx.loopStack) {
        for (var i = ctx.loopStack.length - 1; i >= 0; i--) {
          if (ctx.loopStack[i] && ctx.loopStack[i].iter) { top = ctx.loopStack[i]; break; }
        }
      }
      if (!top) return mark(m0);
      if (w === 'first') return mark('($' + top.iter + '_index === 1)');
      if (w === 'index') return mark('$' + top.iter + '_index');
      return mark('($' + top.iter + '_index - 1)');
    });

    // x is defined / x is not defined — операнд может быть путём с индексами:

    // защита in_array/array/isset/empty от повторной обработки ниже
    var marks = [];
    function mark(x) { marks.push(x); return '\u0002' + (marks.length - 1) + '\u0002'; }

    // x is defined / x is not defined — операнд может быть путём с индексами:
    // ex_reviews['text_bought'][language['language_id']] is defined
    s = s.replace(/\b([\w.]+(?:\[[^\[\]]*(?:\[[^\[\]]*\])?[^\[\]]*\])*)\s+is\s+not\s+defined\b/g, function (m0, x) {
      var b = convPathExpr(x) || (convBaseExpr(x) ? convBaseExpr(x).php : null);
      return mark(b ? '!isset(' + b + ')' : '!isset($' + x + ')');
    });
    s = s.replace(/\b([\w.]+(?:\[[^\[\]]*(?:\[[^\[\]]*\])?[^\[\]]*\])*)\s+is\s+defined\b/g, function (m0, x) {
      var b = convPathExpr(x) || (convBaseExpr(x) ? convBaseExpr(x).php : null);
      return mark(b ? 'isset(' + b + ')' : 'isset($' + x + ')');
    });
    // x is not empty / x is empty (реальный кейс ex_reviews: parent_folder is not empty or ...)
    s = s.replace(/\b([\w.]+(?:\[[^\[\]]*\])*)\s+is\s+not\s+empty\b/g, function (m0, x) {
      var b = convPathExpr(x) || (convBaseExpr(x) ? convBaseExpr(x).php : null);
      return mark(b ? '!empty(' + b + ')' : m0);
    });
    s = s.replace(/\b([\w.]+)\s+is\s+empty\b/g, function (m0, x) {
      var b = convPathExpr(x) || (convBaseExpr(x) ? convBaseExpr(x).php : null);
      return mark(b ? 'empty(' + b + ')' : 'empty($' + x + ')');
    });

    // attribute(_context, X) == 'lit'
    s = s.replace(/attribute\(_context,\s*([^(]+?)\)\s*(==|!=|>=|<=|>|<)\s*(\u0000\d+:\d+\u0000)/g,
      function (_, inner, op, lit) {
        return mark('${' + segConcat(inner) + '} ' + op + ' ' + lit);
      });
    // attribute(_context, X) — истинность
    s = s.replace(/attribute\(_context,\s*([^(]+?)\)/g, function (_, inner) {
      return mark('!empty(${' + segConcat(inner) + '})');
    });

    // x in ['a','b'] / x in listvar
    s = s.replace(/\b([\w.]+)\s+in\s+\[(.*?)\]/g, function (_, x, items) {
      var b = convBaseExpr(x);
      var its = items.split(',').map(function (it) { return it.trim(); })
        .filter(function (it) { return it !== ''; }).join(', ');
      return mark('in_array(' + (b ? b.php : '$' + x) + ', array(' + its + '))');
    });
    s = s.replace(/\b([\w.]+)\s+in\s+([a-z_]\w*)\b/g, function (_, x, list) {
      if (isKeyword(list)) return _;
      var b = convBaseExpr(x);
      return mark('in_array(' + (b ? b.php : '$' + x) + ', $' + list + ')');
    });

    // empty x — операнд НЕ ключевой (иначе правило съедает 'empty or ...'
    // и порождает невалидное empty($or))
    s = s.replace(/\bempty\s+([a-zA-Z_]\w*)\b/g, function (m0, w) {
      if (isKeyword(w)) return m0;
      return mark('empty($' + w + ')');
    });

    // цепочки a.b[c['d']] → $a['b'][$c['d']] (в т.ч. вложенные индексы)
    s = s.replace(/(?<!\$)\b([a-zA-Z_]\w*)((?:\.[a-zA-Z_]\w*|\[(?:[^\[\]]|\[[^\[\]]*\])*\])+)/g,
      function (m0, o1, rest) {
        if (m0.indexOf('loop.') === 0) return m0;
        return convPathExpr(o1 + rest) || m0;
      });

    // диапазон a..b → range(a, b) ({% for i in 1..5 %})
    s = s.replace(/\b([a-zA-Z_]\w*|\d+)\s*\.\.\s*([a-zA-Z_]\w*|\d+)\b/g, function (_, a, b) {
      return 'range(' + (/^\d+$/.test(a) ? a : '$' + a) + ', ' + (/^\d+$/.test(b) ? b : '$' + b) + ')';
    });

    // голые слова → $word (кроме ключевых, чисел и вызовов функций range(...) и т.п.)
    s = s.replace(/(?<![\w$\u0000\u0002])\b([a-zA-Z_]\w*)\b(?!\s*\()(?![\w'\u0000\u0002])/g, function (m0, w) {
      if (isKeyword(w)) return m0;
      return '$' + w;
    });

    // twig-операторы → PHP: not в PHP не существует, 'or not' из ex_reviews:
    // {% if a or not b %}; and/or тоже приводим к &&/|| ради единообразной приоритетности
    s = s.replace(/\bor not\b/g, '|| !');
    s = s.replace(/\bor\b/g, '||');
    s = s.replace(/\band\b/g, '&&');
    s = s.replace(/\bnot\b/g, '!');

    // восстановление защищённых фрагментов
    s = s.replace(/\u0002(\d+)\u0002/g, function (_, i) { return marks[+i]; });

    return prot.restore(s);
  }

  /* ---- twig-путь a.b[c['d']] → PHP $a['b'][$c['d']] (с защитой строк) ---- */
  function convPathExpr(e) {
    var prot = protectStrings(e);
    var s = prot.s;
    var m = s.match(/^(?:\$)?([a-zA-Z_]\w*)((?:\.[a-zA-Z_]\w*|\[(?:[^\[\]]|\[[^\[\]]*\])*\])+)$/);
    if (!m) return null;
    var php = '$' + m[1];
    var tail = m[2];
    while (tail.length) {
      if (tail[0] === '.') {
        var dm = tail.match(/^\.([a-zA-Z_]\w*)/);
        if (!dm) return null;
        php += "['" + dm[1] + "']";
        tail = tail.slice(dm[0].length);
      } else {
        var im = tail.match(/^\[((?:[^\[\]]|\[[^\[\]]*\])*)\]/);
        if (!im) return null;
        var idx = im[1].trim();
        if (idx === '') { php += '[]'; }
        else if (/^[\u0000\d:\s]+$/.test(idx)) { php += '[' + idx + ']'; } // токен строки — как есть
        else {
          var cb = convBaseExpr(idx);
          if (cb) php += '[' + cb.php + ']';
          else {
            var inner = convPathExpr(idx);
            if (inner === null) return null;
            php += '[' + inner + ']';
          }
        }
        tail = tail.slice(im[0].length);
      }
    }
    return prot.restore(php);
  }

  /* ---- индекс внутри [...] — путь/литерал, иначе через convCond ---- */
  function convExprSub(idx, warnings) {
    var p = convPathExpr(idx);
    if (p !== null) return p;
    var b = convBaseExpr(idx);
    if (b) return b.php;
    return convCond(idx, warnings);
  }

  /* ---- теги {% ... %} ---- */
  function convTag(tag, ctx, warnings) {
    tag = tag.trim();
    if (tag === 'else') return '<?php } else { ?>';
    if (tag === 'endif') return '<?php } ?>';
    if (tag === 'endfor') { ctx.loopStack.pop(); return '<?php } ?>'; }
    if (tag === 'endset') { warnings.push('{% endset %} не поддержан'); return null; }

    var m = tag.match(/^if\s+([\s\S]+)$/);
    if (m) { ctx.loopStack.push(null); return '<?php if (' + convCond(m[1], warnings, ctx) + ') { ?>'; }
    m = tag.match(/^elseif\s+([\s\S]+)$/);
    if (m) { return '<?php } elseif (' + convCond(m[1], warnings) + ') { ?>'; }

    // {% for key, value in coll %} (с ключом) / {% for value in coll %}
    m = tag.match(/^for\s+(\w+)\s*,\s*(\w+)\s+in\s+([\s\S]+)$/);
    if (m) {
      var keyIter = m[2];
      var keyColl = convCond(m[3], warnings, ctx);
      ctx.loopStack.push({ iter: keyIter, needCounter: false });
      return { forOpen: true, iter: keyIter, key: m[1], coll: keyColl };
    }

    m = tag.match(/^for\s+(\w+)\s+in\s+([\s\S]+)$/);
    if (m) {
      var iter = m[1];
      var coll = convCond(m[2], warnings, ctx);
      ctx.loopStack.push({ iter: iter, needCounter: false });
      return { forOpen: true, iter: iter, coll: coll };
    }

    m = tag.match(/^set\s+(\w+)\s*=\s*\{([\s\S]*)\}$/);
    if (m) {
      // twig-словарь: {% set x = { 'k': expr, ... } %} (в т.ч. многострочный)
      var mapName = m[1];
      var items = [];
      var bad = false;
      m[2].split(',').forEach(function (pair) {
        pair = pair.trim();
        if (pair === '') return;
        var pm = pair.match(/^(['"])([\s\S]*?)\1\s*:\s*([\s\S]*)$/);
        if (!pm) { bad = true; return; }
        var val = convEcho(pm[3].trim(), ctx, warnings);
        if (val === null) { bad = true; return; }
        items.push("'" + pm[2] + "' => " + val);
      });
      if (bad) {
        warnings.push('{% set ' + mapName + ' = {…} %}: словарь не распознан, тег перенесён как есть');
        return null;
      }
      return '<?php $' + mapName + ' = array(' + items.join(', ') + '); ?>';
    }

    m = tag.match(/^set\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (m) {
      var name = m[1];
      var expr = m[2].trim();
      var phpExpr;
      if (/^\d+(\.\d+)?$/.test(expr) || /^'[^']*'$/.test(expr)) phpExpr = expr;
      else if (/^\[[\s\S]*\]$/.test(expr)) phpExpr = 'array(' + expr.slice(1, -1) + ')';
      else if (/^\w+\s*\+\s*\w+$/.test(expr)) {
        var pp = expr.split('+').map(function (x) { return x.trim(); });
        phpExpr = '$' + pp[0] + ' + ' + (/^\d+$/.test(pp[1]) ? pp[1] : '$' + pp[1]);
      }
      else {
        // общий случай: convEcho (тернарники, фильтры, is defined) → convValue →
        // convCond (арифметика j - 1, or/and/not, in, is defined)
        var conv = convEcho(expr, ctx, warnings);
        if (conv === null) conv = convValue(expr, ctx, warnings);
        if (conv === null) conv = convCond(expr, warnings, ctx);
        if (conv === null) {
          warnings.push('{% set ' + name + ' = … %}: выражение не распознано, тег перенесён как есть');
          return null;
        }
        phpExpr = conv;
      }
      return '<?php $' + name + ' = ' + phpExpr + '; ?>';
    }

    warnings.push('тег {% ' + tag.split(' ')[0] + ' %} не поддержан — перенесён как есть');
    return null;
  }

  /* ---- основной проход: разбор → анализ циклов → сборка ---- */
  function convert(src, options) {
    options = options || {};
    var warnings = [];
    var ctx = {
      issetGuard: options.issetGuard !== false,
      loopStack: []
    };

    // 0. twig-комментарии {# ... #} удаляются (иначе попадут в вывод как текст)
    src = src.replace(/\{#[\s\S]*?#\}/g, '');

    // 1. разбор в упорядоченный список событий
    var events = [];
    var re = /\{%\s*([\s\S]+?)\s*%\}|\{\{\s*([\s\S]+?)\s*\}\}/g;
    var mm;
    var last = 0;
    while ((mm = re.exec(src)) !== null) {
      if (mm.index > last) events.push({ type: 'text', raw: src.slice(last, mm.index) });
      if (mm[1] !== undefined) events.push({ type: 'tag', inner: mm[1], raw: mm[0] });
      else events.push({ type: 'echo', inner: mm[2], raw: mm[0] });
      last = re.lastIndex;
    }
    if (last < src.length) events.push({ type: 'text', raw: src.slice(last) });

    // 2. анализ: каким циклам нужен счётчик loop.index
    var stack = [];
    events.forEach(function (ev) {
      if (ev.type === 'tag') {
        var fm = ev.inner.trim().match(/^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+/);
        if (fm) { var frame = { iter: fm[2] || fm[1], needCounter: false }; stack.push(frame); ev.frame = frame; return; }
        if (/^endfor$/.test(ev.inner.trim()) && stack.length) { ev.frame = stack.pop(); }
        return;
      }
      if (ev.type === 'echo' && /loop\.(index|index0|first)\b/.test(ev.inner) && stack.length) {
        stack[stack.length - 1].needCounter = true;
      }
    });
    events.forEach(function (ev) { if (ev.type === 'echo' && /loop\.index0?\b/.test(ev.inner) && !stack.length && !ctx.loopStack.length) {
      // loop.index вне цикла — предупреждение при сборке
    }});

    // 3. сборка
    var out = [];
    var stats = { echoes: 0, tags: 0 };
    events.forEach(function (ev) {
      if (ev.type === 'text') { out.push(ev.raw); return; }
      if (ev.type === 'tag') {
        stats.tags++;
        ctx.loopStack = ctx.loopStack; // сброс не нужен — стек восстанавливаем по событию
        // восстановление контекста стека циклов на этапе сборки:
        // (стек из фазы анализа уже потрачен, ведём отдельный)
        if (ev.frame && ev.frame.iter && ev.inner.trim().match(/^for\s/)) {
          // открывающий for
          ctx.loopStack.push(ev.frame);
          var t = convTag(ev.inner, ctx, warnings);
          if (t && t.forOpen) {
            var asPart = t.key ? ' as $' + t.key + ' => $' + t.iter : ' as $' + t.iter;
            if (ev.frame.needCounter) {
              out.push('<?php $' + ev.frame.iter + '_index = 0; foreach (' + t.coll + asPart + ') { $' + ev.frame.iter + '_index++; ?>');
            } else {
              out.push('<?php foreach (' + t.coll + asPart + ') { ?>');
            }
          } else if (typeof t === 'string') {
            out.push(t);
          } else {
            warnings.push('{% for %}: не удалось преобразовать — перенесён как есть');
            out.push(ev.raw);
          }
          return;
        }
        if (ev.frame && /^endfor$/.test(ev.inner.trim())) {
          if (ctx.loopStack.length) ctx.loopStack.pop();
          out.push('<?php } ?>');
          return;
        }
        var res = convTag(ev.inner, ctx, warnings);
        if (res === null) { out.push(ev.raw); return; }
        out.push(typeof res === 'string' ? res : ev.raw);
        return;
      }
      // echo
      stats.echoes++;
      var lm = ev.inner.trim().match(/^loop\.(\w+)$/);
      if (lm) {
        var top = null;
        for (var i = ctx.loopStack.length - 1; i >= 0; i--) {
          if (ctx.loopStack[i] && ctx.loopStack[i].iter) { top = ctx.loopStack[i]; break; }
        }
        if (!top) {
          warnings.push('loop.' + lm[1] + ' вне цикла for — конструкция перенесена как есть');
          out.push(ev.raw);
          return;
        }
        if (lm[1] === 'index') { out.push('<?php echo $' + top.iter + '_index; ?>'); return; }
        if (lm[1] === 'index0') { out.push("<?php echo ($" + top.iter + "_index - 1); ?>"); return; }
      }
      var php = convEcho(ev.inner, ctx, warnings);
      if (php === null) { out.push(ev.raw); return; }
      if (php.indexOf('llms_js_escape(') === 0 && out.join('').indexOf('llms_js_escape') === -1) {
        out.push(JS_HELPER);
      }
      if (php.indexOf('\u0001') === 0) {
        out.push('<?php echo ' + php.replace(/^\u0001/, '').replace(/\u0001$/, '') + '; ?>');
        return;
      }
      out.push('<?php echo ' + php + '; ?>');
    });

    var output = out.join('');
    if (options.tokenRename !== false) {
      output = output.split('user_token').join('token');
    }
    return { output: output, warnings: warnings, stats: stats };
  }

  /* ---- тесты (реальные кейсы из порта модуля и сравнения онлайн-конвертеров) ---- */
  // JS-escape helper, добавляемый в начало вывода при первом использовании |e('js').
  // Расширяет addslashes переводами строк (единственное, чего не хватает для JS-литералов)
  // и NUL-байтом. Кавычки/слеш уже экранирует сам addslashes.
  var JS_HELPER = "<?php if (!function_exists('llms_js_escape')) { function llms_js_escape($s) { return addcslashes(addslashes($s), \"\\r\\n\\0\\v\\f\"); } } ?>";
  var TESTS = [
    { name: '{{ var }}', in: '{{ heading_title }}', expect: "<?php echo $heading_title; ?>" },
    { name: 'if/endif', in: '{% if products %}A{% endif %}', expect: "<?php if ($products) { ?>A<?php } ?>" },
    { name: 'for + доступ по точке', in: '{% for product in products %}{{ product.name }}{% endfor %}',
      expect: "<?php foreach ($products as $product) { ?><?php echo $product['name']; ?><?php } ?>" },
    { name: "сравнение без потери $ (баг begemod/dev-opencart)", in: "{% if key == 'custom' %}C{% endif %}",
      expect: "<?php if ($key == 'custom') { ?>C<?php } ?>" },
    { name: "|e('js') → llms_js_escape (addslashes + переводы строк)", in: "{{ text_displayed|e('js') }}", expect: 'llms_js_escape($text_displayed)' },
    { name: "|e(\"js\") с двойными кавычками", in: '{{ x|e("js") }}',
      expect: 'llms_js_escape($x)' },
    { name: '|format + loop.index → sprintf + счётчик', in: '{% for product in products %}{{ \'%02d\'|format(loop.index) }}{% endfor %}',
      expect: "sprintf('%02d', $product_index)" },
    { name: 'set с массивом (ломает онлайн-конвертеры)', in: '{% set tab_keys = [\'categories\', \'products\'] %}',
      expect: "array('categories', 'products')" },
    { name: 'attribute(_context) → переменная-переменная', in: "{{ attribute(_context, 'tab_' ~ key) }}",
      expect: "isset(${'tab_' . $key}) ? ${'tab_' . $key}" },
    { name: 'тернарник', in: "{{ llms_generator_readonly_mode ? 'true' : 'false' }}",
      expect: "$llms_generator_readonly_mode ? 'true' : 'false'" },
    { name: 'user_token → token', in: "index.php?route=x&user_token={{ user_token }}",
      expect: "&token=<?php echo $token; ?>" },
    { name: 'is defined', in: '{% if store is defined %}A{% endif %}',
      expect: 'isset($store)' },
    { name: 'in [...] → in_array', in: "{% if key in ['a', 'b'] %}A{% endif %}",
      expect: "in_array($key, array('a', 'b'))" }
  ];

  function runTests() {
    return TESTS.map(function (t) {
      var r;
      try { r = convert(t.in, { tokenRename: t.name.indexOf('user_token') !== -1 }); }
      catch (e) { return { name: t.name, pass: false, detail: 'exception: ' + e.message }; }
      var pass = r.output.indexOf(t.expect) !== -1
        && r.output.indexOf('{{') === -1
        && r.output.indexOf('{%') === -1;
      return { name: t.name, pass: pass, output: r.output, expect: t.expect };
    });
  }

  return { version: VERSION, convert: convert, runTests: runTests, TESTS: TESTS };
});
