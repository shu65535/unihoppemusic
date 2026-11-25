// 自動生成ファイル。直接編集しない（src/presets/*/*.json を編集して node tools/build-presets.js を実行）
(function (root) {
  'use strict';
  const MH = (root.MH = root.MH || {});
  MH.BUILTIN_PRESET_DATA = {
    "piano": {
      "default": {
        "version": 2,
        "instrument": "piano",
        "name": "デフォルト",
        "source": "builtin",
        "order": 10,
        "meter": "4/4",
        "note": "Phase 2 の音源解析で 4/4 の25曲から出した値の中央値（draft/presets/piano/_merged_piano_4-4.json の写し）。曲: 06 M07.m4a / 06 Ｍ０７.m4a / 1-03 grief.m4a / 1-05 on a day so calm.m4a / 1-07 Desiderium.m4a / 1-11 Inevitabilis.m4a / 1-18 school girl life.m4a / 1-21 painful.m4a / 1-26 at our parting ～piano only.m4a / 1-37 friendly feelings ～piano only.m4a / 14 fake jewel.wav / 19 Parting song.m4a / 2-02 Amicae carae meae.m4a / 2-11 Quamobrem_.m4a / 2-16 Taenia memoriae.m4a / 2-16 is this love_ ～piano only ver..m4a / 20 M22.m4a / 22 M22.m4a / 22 the breath of the era.m4a / 3-05 a tiny stream.m4a / 3-17 good bye, again and again.m4a / 33 媛星 ～真白～.m4a / 36 M38 + 39.m4a / 39 M43.m4a / 4-25 you are not alone ～piano ver..m4a",
        "params": {
          "accentGrid": {
            "*": {
              "scale": 3.6
            },
            "4/4": {
              "acc": [
                5,
                -2,
                1,
                -2,
                5,
                -3,
                1,
                -3,
                5,
                -2,
                0,
                -4,
                5,
                -2,
                1,
                -3,
                3,
                -3,
                0,
                -3,
                4,
                -2,
                0,
                -4,
                3,
                -2,
                0,
                -3,
                6,
                -3,
                2,
                -3
              ]
            }
          },
          "accompLengthRatio": 1.2,
          "accompTimingSd": 8,
          "accompVelArc": 17,
          "accompVelBase": 64,
          "bassBoost": -5,
          "beatShift": {
            "4": {
              "at": [
                0,
                0,
                0,
                0
              ],
              "mid": [
                0,
                0,
                0,
                0
              ]
            }
          },
          "chordSpreadMs": 0,
          "legatoMs": 26,
          "melodyLeadMs": 2,
          "melodyTimingSd": 11,
          "melodyVelArc": 22,
          "melodyVelBase": 75,
          "pedal": true,
          "phraseEndRitMs": 1,
          "rhInnerArcRatio": 0.85,
          "rhInnerVelOffset": 5,
          "velJitter": 8
        },
        "handStats": {
          "R": {
            "leadMs": 2,
            "lengthRatio": 1,
            "notes": 6742,
            "timingSdMs": 11.3,
            "velArc": 29.9,
            "velMean": 73,
            "velSd": 12.6
          },
          "L": {
            "lengthRatio": 1.5,
            "notes": 4013,
            "timingSdMs": 7.6,
            "velArc": 30,
            "velMean": 64.6,
            "velSd": 11.8
          }
        }
      },
      "default_3-4": {
        "version": 2,
        "instrument": "piano",
        "name": "デフォルト",
        "source": "builtin",
        "order": 20,
        "meter": "3/4",
        "note": "Phase 2 の音源解析で 3/4 の3曲から出した値の中央値（draft/presets/piano/_merged_piano_3-4.json の写し）。曲: 1-23 moonlight melody ～Piano ver..m4a / 17 M23.m4a / 18 M24.m4a",
        "params": {
          "accentGrid": {
            "*": {
              "scale": 2.2
            },
            "3/4": {
              "acc": [
                9,
                -1,
                -2,
                -4,
                4,
                -6,
                0,
                -1,
                7,
                -1,
                7,
                -4,
                9,
                0,
                6,
                -5,
                4,
                -6,
                0,
                1,
                7,
                -5,
                3,
                -6
              ]
            }
          },
          "accompLengthRatio": 1.2,
          "accompTimingSd": 9,
          "accompVelArc": 27,
          "accompVelBase": 60,
          "bassBoost": -3,
          "beatShift": {
            "3": {
              "at": [
                0,
                0,
                2
              ],
              "mid": [
                7,
                0,
                0
              ]
            }
          },
          "chordSpreadMs": 2,
          "legatoMs": 0,
          "melodyLeadMs": 0,
          "melodyTimingSd": 17,
          "melodyVelArc": 16,
          "melodyVelBase": 65,
          "pedal": true,
          "phraseEndRitMs": 0,
          "rhInnerArcRatio": 0.4,
          "rhInnerVelOffset": 4,
          "velJitter": 5.5
        },
        "handStats": {
          "R": {
            "leadMs": 0,
            "lengthRatio": 1,
            "notes": 888,
            "timingSdMs": 16.6,
            "velArc": 25.5,
            "velMean": 69.7,
            "velSd": 10.4
          },
          "L": {
            "lengthRatio": 1.7,
            "notes": 472,
            "timingSdMs": 8.9,
            "velArc": 29,
            "velMean": 60,
            "velSd": 12.5
          }
        }
      },
      "init": {
        "version": 2,
        "instrument": "piano",
        "name": "--init--",
        "source": "builtin",
        "order": 20,
        "note": "プリセットづくりのための初期値。揺れ・ランダム幅・拍ごとのタメ・強弱のパターン・抑揚などの効き目を0にしたもの。ベロシティ基準は他のプリセットと同じ「固定」で、基準値がそのまま効く。和音の微小なずれなど、コードに固定で入っているわずかな揺れは残る",
        "params": {
          "accentGrid": {},
          "accentVelDepth": 0,
          "accentVelSdDiff": 0,
          "melodyVelArc": 0,
          "rhInnerVelOffset": 0,
          "accompVelArc": 0,
          "bassBoost": 0,
          "phraseEndSoften": 0,
          "velJitter": 0,
          "beatShift": {},
          "melodyTimingSd": 0,
          "melodyLeadMs": 0,
          "accompTimingSd": 0,
          "chordSpreadMs": 0,
          "phraseEndRitMs": 0,
          "legatoMs": 0,
          "accompLengthRatio": 1,
          "lengthJitter": 0,
          "phraseEndExtend": 0
        }
      },
      "neutral": {
        "version": 2,
        "instrument": "piano",
        "name": "ニュートラル（控えめ）",
        "source": "builtin",
        "order": 50,
        "params": {
          "melodyVelArc": 10,
          "accompVelBase": 64,
          "melodyVelBase": 72,
          "beatShift": {},
          "melodyLeadMs": 0,
          "phraseEndRitMs": 0,
          "accompVelArc": 4
        }
      }
    },
    "guitar": {
      "default": {
        "version": 2,
        "instrument": "guitar",
        "name": "デフォルト",
        "source": "builtin",
        "order": 10,
        "meter": "4/4",
        "note": "Phase 2 の音源解析で 4/4 の12曲から出した値の中央値（draft/presets/guitar/_merged_guitar_4-4.json の写し）。曲: 1-12 battle of the shadows.m4a / 04 frenetic.m4a / 2-09 godsibb.m4a / 1-22 lancer and assassin.m4a / 1-21 luminous sword.m4a / 14 M19 + 20.m4a / 22 M24.m4a / 2-10 Numquam vincar.m4a / 3-16 she has to overcome her fear.m4a / 3-22 the four rings.m4a / 1-15 Venari strigas.m4a / 37 we're here for you.m4a",
        "params": {
          "beatShift": {
            "4": {
              "at": [
                0,
                0,
                0,
                0
              ],
              "mid": [
                0,
                0,
                0,
                0
              ]
            }
          },
          "phraseArc": 11,
          "strumPattern": {
            "4/4": {
              "acc": [
                -5,
                3,
                -3,
                2,
                -5,
                4,
                -1,
                5,
                -5,
                5,
                -1,
                5,
                -6,
                5,
                -1,
                1
              ]
            }
          },
          "timingSd": 15,
          "velBase": 52,
          "velJitter": 7
        }
      },
      "init": {
        "version": 2,
        "instrument": "guitar",
        "name": "--init--",
        "source": "builtin",
        "order": 20,
        "note": "プリセットづくりのための初期値。揺れ・ランダム幅・拍ごとのタメ・強弱のパターン・抑揚などの効き目を0にしたもの。ベロシティ基準は他のプリセットと同じ「固定」で、基準値がそのまま効く。和音の微小なずれなど、コードに固定で入っているわずかな揺れは残る",
        "params": {
          "strumPattern": {},
          "accentVelDepth": 0,
          "accentVelSdDiff": 0,
          "phraseArc": 0,
          "downVelBoost": 0,
          "upVelCut": 0,
          "stringVelDecay": 0,
          "brushVelCut": 0,
          "pmVelCut": 0,
          "pmHighCut": 0,
          "velJitter": 0,
          "strumDownMs": 0,
          "strumUpMs": 0,
          "strumSpreadJitter": 0,
          "timingSd": 0,
          "beatShift": {},
          "muteGapMs": 0,
          "muteOnChordChange": false,
          "letRing": 0,
          "lengthJitter": 0
        }
      },
      "neutral": {
        "version": 2,
        "instrument": "guitar",
        "name": "ニュートラル（控えめ）",
        "source": "builtin",
        "order": 40,
        "params": {
          "phraseArc": 6,
          "letRing": 0.2
        }
      }
    },
    "drums": {
      "default": {
        "version": 2,
        "instrument": "drums",
        "name": "デフォルト",
        "source": "builtin",
        "order": 10,
        "meter": "4/4",
        "note": "Phase 2 の音源解析で 4/4 の11曲から出した値の中央値（draft/presets/drums/_merged_drums_4-4.json の写し）。曲: 19 absolute configuration.m4a / 1-12 battle of the shadows.m4a / 04 frenetic.m4a / 2-09 godsibb.m4a / 1-21 luminous sword.m4a / 22 M24.m4a / 2-10 Numquam vincar.m4a / 3-16 she has to overcome her fear.m4a / 3-22 the four rings.m4a / 1-15 Venari strigas.m4a / 37 we're here for you.m4a",
        "params": {
          "accentGrid": {
            "4/4": {
              "acc": [
                1,
                0,
                0,
                -5,
                1,
                0,
                0,
                -2,
                0,
                0,
                0,
                -2,
                1,
                -2,
                0,
                -3,
                1,
                0,
                0,
                -5,
                1,
                0,
                0,
                -2,
                0,
                -2,
                0,
                -3,
                1,
                -2,
                0,
                -3
              ]
            }
          },
          "beatShift": {
            "4": {
              "at": [
                0,
                0,
                0,
                0
              ],
              "mid": [
                10,
                11,
                7,
                12
              ],
              "swing": 58.5
            }
          },
          "ghostNotes": false,
          "ghostVel": 62,
          "hat16Cut": 4,
          "hatAccent": 0,
          "hatOffCut": 0,
          "hatOffPushMs": 2,
          "hatSd": 8,
          "hatVel": 53,
          "kickDownbeat": 3,
          "kickSd": 7,
          "kickVel": 95,
          "phraseArc": 3,
          "snareLaybackMs": 3,
          "snareSd": 8,
          "snareVel": 48,
          "velJitter": 9.5,
          "rimVel": 33,
          "hatPedalVel": 53,
          "hatOpenVel": 59
        }
      },
      "init": {
        "version": 2,
        "instrument": "drums",
        "name": "--init--",
        "source": "builtin",
        "order": 20,
        "note": "プリセットづくりのための初期値。揺れ・ランダム幅・拍ごとのタメ・強弱のパターン・抑揚などの効き目を0にしたもの。ベロシティ基準は他のプリセットと同じ「固定」で、基準値がそのまま効く。和音の微小なずれなど、コードに固定で入っているわずかな揺れは残る",
        "params": {
          "accentGrid": {},
          "accentVelDepth": 0,
          "accentVelSdDiff": 0,
          "phraseArc": 0,
          "velJitter": 0,
          "kickDownbeat": 0,
          "ghostNotes": false,
          "hatAccent": 0,
          "hatOffCut": 0,
          "hat16Cut": 0,
          "fillCresc": 0,
          "beatShift": {},
          "kickSd": 0,
          "snareSd": 0,
          "snareLaybackMs": 0,
          "ghostSd": 0,
          "hatSd": 0,
          "hatOffPushMs": 0,
          "tomSd": 0,
          "cymbalSd": 0
        }
      },
      "neutral": {
        "version": 2,
        "instrument": "drums",
        "name": "ニュートラル（控えめ）",
        "source": "builtin",
        "order": 30,
        "params": {
          "phraseArc": 0,
          "snareLaybackMs": 0,
          "hatOffPushMs": 0
        }
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
