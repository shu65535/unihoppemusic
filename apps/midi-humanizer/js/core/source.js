/**
 * 読み込み段: MIDIファイルを一次データ（加工の元になるMIDI）として読み込み、検査して、読み込み設定のモーダルに出す情報をまとめる。
 * 画面には依存しない（楽器・対象パートの選択は ui/load-dialog.js、state への反映は ui/app.js）。
 */
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});

  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_NOTES = 100000;

  /**
   * @param {ArrayBuffer} buffer ファイルの中身
   * @param {string} fileName 表示用のファイル名
   * @returns {{midi:object, notes:object[], maps:object, meter:string, info:string, parts:object[]}}
   *   meter: 最も長く続く拍子（プリセットの振り分けに使う）。info: ファイルの情報（モーダル・設定「一般」に表示する）。parts: MH.listParts の結果
   */
  function loadSource(buffer, fileName) {
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('ファイルが大きすぎます（上限10MB）');
    const midi = MH.parseMidi(buffer);
    const notes = MH.extractNotes(midi);
    if (!notes.length) throw new Error('ノートが含まれていません');
    if (notes.length > MAX_NOTES) throw new Error(`ノート数が多すぎます（${notes.length} / 上限 ${MAX_NOTES}）`);
    const maps = MH.buildTimeMaps(midi);
    const bpm = (60000000 / maps.tempos[0].us).toFixed(1);
    // 拍子が途中で変わるときは、最も長く続く拍子をプリセットの振り分けに使う
    const meter = MH.dominantMeter(maps, notes.reduce((a, n) => Math.max(a, n.endTick), 0));
    const sigText = maps.sigs.length > 1 ? `${meter} ほか（拍子の変更 ${maps.sigs.length - 1} 回）` : meter;
    const info = `${fileName}\n${notes.length} ノート / ${bpm} BPM / ${sigText} / PPQ ${midi.ppq}`;
    return { midi, notes, maps, meter, info, parts: MH.listParts(midi) };
  }

  MH.loadSource = loadSource;
  MH.MAX_FILE_BYTES = MAX_FILE_BYTES;
})(typeof window !== 'undefined' ? window : globalThis);
