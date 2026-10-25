/**
 * Twig2TPL Batch — пакетная конвертация папки с шаблонами.
 * Версия: 0.13 (соответствует ядру twig2tpl.js).
 *
 * Возможности:
 *   - collectFiles(fileList)     — отбор входа (input[webkitdirectory] или drop),
 *                                  фильтр служебных папок (.git, __MACOSX, dot-папки),
 *                                  сортировка по пути.
 *   - collectFromDrop(items)     — рекурсивный обход папки, брошенной мышью
 *                                  (DataTransferItem.webkitGetAsEntry, браузер).
 *   - convertEntries(entries, opts, onProgress) — чтение файлов, конвертация
 *                                  .twig → .tpl ядром Twig2TPL, отчёт по каждому файлу.
 *   - zipStore(files)            — упаковка в ZIP (метод store, без сжатия)
 *                                  без внешних библиотек: CRC-32, UTF-8 имена,
 *                                  структура путей сохраняется.
 *
 * Файлы без расширения .twig не конвертируются — попадают в архив байт в байт.
 * Ошибочный .twig попадает в архив в исходном виде со статусом error в отчёте.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Twig2TPLBatch = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.13';

  /* ---- служебные папки/файлы, которые не должны попасть в архив ---- */
  function isJunkSegment(seg) {
    if (!seg) return true;
    if (seg === '__MACOSX') return true;
    if (seg.charAt(0) === '.') return true; // .git, .svn, .DS_Store, .gitignore и т.п.
    return false;
  }

  function isJunkPath(rel) {
    return rel.split('/').some(isJunkSegment);
  }

  /* ---- отбор файлов из input[type=file] (webkitdirectory) или drop-списка ---- */
  function collectFiles(fileList) {
    var out = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rel = f.webkitRelativePath || f.relativePath || f.name;
      if (isJunkPath(rel)) continue;
      out.push({ path: rel.replace(/\\/g, '/'), file: f });
    }
    out.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
    return out;
  }

  /* ---- рекурсивный обход папки, брошенной в drag&drop (только браузер) ---- */
  function readAllEntries(dirEntry) {
    return new Promise(function (resolve, reject) {
      var all = [];
      var reader = dirEntry.createReader();
      (function step() {
        // readEntries отдаёт пачками (обычно до 100) — читаем до пустого ответа
        reader.readEntries(function (batch) {
          if (!batch.length) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch));
          step();
        }, reject);
      })();
    });
  }

  function entryFile(entry) {
    return new Promise(function (resolve, reject) { entry.file(resolve, reject); });
  }

  function collectFromEntry(entry, prefix, out) {
    prefix = prefix || '';
    if (entry.isFile) {
      return entryFile(entry).then(function (file) {
        var rel = prefix + entry.name;
        if (!isJunkPath(rel)) out.push({ path: rel.replace(/\\/g, '/'), file: file });
        return out;
      });
    }
    if (entry.isDirectory) {
      if (isJunkSegment(entry.name)) return Promise.resolve(out);
      return readAllEntries(entry).then(function (children) {
        var p = prefix + entry.name + '/';
        return children.reduce(function (chain, child) {
          return chain.then(function () { return collectFromEntry(child, p, out); });
        }, Promise.resolve());
      }).then(function () { return out; });
    }
    return Promise.resolve(out);
  }

  function collectFromDrop(dataTransfer) {
    var entries = [];
    var items = dataTransfer && dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      for (var i = 0; i < items.length; i++) {
        var e = items[i].webkitGetAsEntry(); // забрать синхронно, до любого await
        if (e) entries.push(e);
      }
    }
    if (!entries.length && dataTransfer && dataTransfer.files) {
      return Promise.resolve(collectFiles(dataTransfer.files));
    }
    var out = [];
    return entries.reduce(function (chain, e) {
      return chain.then(function () { return collectFromEntry(e, '', out); });
    }, Promise.resolve()).then(function () {
      out.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
      return out;
    });
  }

  /* ---- чтение текста файла: File API (браузер) или фейк с .text() (node-тесты) ---- */
  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('FileReader: не удалось прочитать файл')); };
      r.readAsText(file, 'utf-8');
    });
  }

  /* ---- конвертация списка записей ----
   * entries: [{path, file}]; opts: {tokenRename, issetGuard}
   * onProgress(done, total, path) — опционально.
   */
  function convertEntries(entries, opts, onProgress) {
    var results = [];
    var i = 0;
    function next() {
      if (i >= entries.length) return Promise.resolve(results);
      var entry = entries[i++];
      if (onProgress) { try { onProgress(i, entries.length, entry.path); } catch (e) {} }
      var res = { path: entry.path, status: 'skipped', warnings: [], zipPath: entry.path, file: entry.file, size: 0 };
      results.push(res);
      var read = Promise.resolve();
      if (/\.twig$/i.test(entry.path)) {
        res.zipPath = entry.path.replace(/\.twig$/i, '') + '.tpl';
        read = readFileText(entry.file).then(function (text) {
          res.size = text.length;
          var r = Twig2TPL.convert(text, {
            tokenRename: opts.tokenRename !== false,
            issetGuard: opts.issetGuard !== false
          });
          res.output = r.output;
          res.warnings = r.warnings.slice();
          if (/\{\{|\{%/.test(r.output)) {
            res.warnings.unshift('в результате остались twig-конструкции — исправьте вручную');
          }
          res.status = 'ok';
        }).catch(function (e) {
          res.status = 'error';
          res.warnings = ['ошибка конвертации: ' + e.message + ' — в архив попал исходный .twig'];
          res.zipPath = entry.path; // исходник без переименования
        });
      }
      return read.then(next);
    }
    return next();
  }

  /* ---- CRC-32 (IEEE 802.3, как в ZIP) ---- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---- DOS-время для записи в ZIP ---- */
  function dosDateTime(d) {
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  /* ---- ZIP (store, без сжатия): files = [{path, data:Uint8Array, mtime?}] ---- */
  function zipStore(files) {
    var enc = new TextEncoder();
    var locals = [], centrals = [];
    var offset = 0;
    var total = 0;

    files.forEach(function (f) {
      var nameU8 = enc.encode(f.path);
      var crc = crc32(f.data);
      var dos = dosDateTime(f.mtime || new Date());

      var lh = new Uint8Array(30);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);       // version needed
      lv.setUint16(6, 0x0800, true);   // флаг UTF-8 имён
      lv.setUint16(8, 0, true);        // метод: store
      lv.setUint16(10, dos.time, true);
      lv.setUint16(12, dos.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, f.data.length, true);
      lv.setUint32(22, f.data.length, true);
      lv.setUint16(26, nameU8.length, true);
      lv.setUint16(28, 0, true);
      locals.push(lh, nameU8, f.data);

      var ch = new Uint8Array(46);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);       // version made by
      cv.setUint16(6, 20, true);       // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);       // метод: store
      cv.setUint16(12, dos.time, true);
      cv.setUint16(14, dos.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nameU8.length, true);
      cv.setUint16(30, 0, true);       // extra len
      cv.setUint16(32, 0, true);       // comment len
      cv.setUint16(34, 0, true);       // disk number
      cv.setUint16(36, 0, true);       // internal attrs
      cv.setUint32(38, 0, true);       // external attrs
      cv.setUint32(42, offset, true);  // смещение local header
      centrals.push(ch, nameU8);

      offset += 30 + nameU8.length + f.data.length;
    });

    var centralSize = centrals.reduce(function (s, p) { return s + p.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    total = offset + centralSize + 22;
    var out = new Uint8Array(total);
    var pos = 0;
    locals.concat(centrals).concat([eocd]).forEach(function (part) {
      out.set(part, pos); pos += part.length;
    });
    return out;
  }

  /* ---- сборка архива из результатов конвертации ----
   * ok-файлы берутся из r.output, остальные — байт в байт из исходника.
   * Файл, который не удалось прочитать, пропускается с пометкой zipOmitted
   * и предупреждением — одна плохая копия не рушит весь пакет.
   */
  function buildZip(results, mtime) {
    var enc = new TextEncoder();
    var files = new Array(results.length);
    var jobs = [];
    results.forEach(function (r, idx) {
      if (r.status === 'ok') {
        files[idx] = { path: r.zipPath, data: enc.encode(r.output) };
        return;
      }
      jobs.push(readFileBytes(r.file).then(function (bytes) {
        files[idx] = { path: r.zipPath, data: bytes };
      }).catch(function (e) {
        r.warnings.push('файл не попал в архив: не удалось прочитать (' + e.message + ')');
        r.zipOmitted = true;
      }));
    });
    return Promise.all(jobs).then(function () {
      var list = files.filter(Boolean);
      if (!list.length) throw new Error('в архиве не оказалось ни одного файла');
      var mt = mtime || new Date();
      list.forEach(function (f) { f.mtime = mt; });
      return zipStore(list);
    });
  }

  function readFileBytes(file) {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return readFileText(file).then(function (s) { return new TextEncoder().encode(s); });
  }

  /* ---- имя архива по корневой папке ---- */
  function zipName(results) {
    var first = results.length ? results[0].path.split('/')[0] : '';
    var common = first && results.every(function (r) { return r.path.split('/')[0] === first; }) ? first : 'converted';
    return common.replace(/[^\w.\-]+/g, '_') + '-tpl.zip';
  }

  return {
    version: VERSION,
    isJunkPath: isJunkPath,
    collectFiles: collectFiles,
    collectFromDrop: collectFromDrop,
    convertEntries: convertEntries,
    buildZip: buildZip,
    zipName: zipName,
    zipStore: zipStore,
    crc32: crc32
  };
});
