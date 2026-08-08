/**
 * 商号の正規化。
 *
 * 目的は 2 つあり、出力も 2 つに分ける。
 *   normalized … 人が読む・表示する用。表記ゆれだけを吸収する
 *   core       … 名寄せの照合キー用。法人格・記号・空白を落として詰める
 *
 * core は照合専用なので情報を落として構わない。normalized は落としてはいけない。
 */

/** 法人格。長いものから先に照合する必要があるため、この順序に意味がある。 */
const CORP_FORMS = [
  '特定非営利活動法人',
  '一般社団法人',
  '一般財団法人',
  '公益社団法人',
  '公益財団法人',
  '地方独立行政法人',
  '独立行政法人',
  '国立大学法人',
  '公立大学法人',
  '医療法人社団',
  '医療法人財団',
  '社会医療法人',
  '特定医療法人',
  '社会福祉法人',
  '学校法人',
  '宗教法人',
  '医療法人',
  '弁護士法人',
  '税理士法人',
  '司法書士法人',
  '行政書士法人',
  '社会保険労務士法人',
  '土地家屋調査士法人',
  '特許業務法人',
  '監査法人',
  '財団法人',
  '社団法人',
  '株式会社',
  '有限会社',
  '合同会社',
  '合資会社',
  '合名会社',
  '相互会社',
  '協同組合',
  '農業協同組合',
  '漁業協同組合',
  '生活協同組合',
  '事業協同組合',
  '信用金庫',
  '信用組合',
  '労働組合',
  '企業組合',
] as const;

/** 括弧つき略記の展開。NFKC 適用後の半角括弧形で照合する。 */
const ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ['(株)', '株式会社'],
  ['(有)', '有限会社'],
  ['(同)', '合同会社'],
  ['(資)', '合資会社'],
  ['(名)', '合名会社'],
  ['(財)', '財団法人'],
  ['(社)', '社団法人'],
  ['(医)', '医療法人'],
  ['(学)', '学校法人'],
  ['(宗)', '宗教法人'],
  ['(福)', '社会福祉法人'],
  ['(特非)', '特定非営利活動法人'],
  ['(相)', '相互会社'],
  ['(組)', '協同組合'],
];

/**
 * 異体字の統一。照合キー (core) にのみ適用する。
 * 表示用の normalized には適用しない — 相手先の正式表記を変えてしまうため。
 */
const VARIANT_KANJI: ReadonlyArray<readonly [string, string]> = [
  ['髙', '高'], ['﨑', '崎'], ['濵', '浜'], ['濱', '浜'], ['邊', '辺'], ['邉', '辺'],
  ['齋', '斎'], ['齊', '斉'], ['澤', '沢'], ['眞', '真'], ['藏', '蔵'], ['國', '国'],
  ['學', '学'], ['會', '会'], ['廣', '広'], ['澁', '渋'], ['榮', '栄'], ['壽', '寿'],
  ['龍', '竜'], ['圓', '円'], ['區', '区'], ['縣', '県'], ['櫻', '桜'], ['瀨', '瀬'],
  ['彌', '弥'], ['惠', '恵'], ['德', '徳'], ['淺', '浅'], ['冨', '富'], ['舘', '館'],
  ['曾', '曽'], ['峯', '峰'], ['檜', '桧'], ['寳', '宝'], ['萬', '万'], ['亞', '亜'],
];

/** 照合キーから落とす記号。 */
const NOISE_CHARS = /[\s・､、,，.．·''"“”「」『』()（）\[\]【】〔〕<>＜＞\-‐-—―ー_／/\\|&＆+＋]/g;

export interface NormalizedName {
  /** 表示用。表記ゆれのみ吸収し、情報は落とさない */
  normalized: string;
  /** 照合用。法人格・記号・空白を落として詰めた形 */
  core: string;
  /** 検出した法人格。見つからなければ null */
  corpForm: string | null;
}

/** 表記ゆれの吸収。全角英数→半角、㈱→(株)、連続空白の圧縮まで。 */
function toNormalized(raw: string): string {
  let s = raw.normalize('NFKC');
  for (const [from, to] of ABBREVIATIONS) {
    s = s.split(from).join(to);
  }
  // NFKC で半角化されたカタカナを全角に戻す用途はないが、空白は揃える
  return s.replace(/[　\s]+/g, ' ').trim();
}

/** 先頭または末尾の法人格を 1 つだけ切り出す。中間に現れるものは名前の一部とみなす。 */
function stripCorpForm(normalized: string): { core: string; corpForm: string | null } {
  for (const form of CORP_FORMS) {
    if (normalized.startsWith(form)) {
      return { core: normalized.slice(form.length), corpForm: form };
    }
    if (normalized.endsWith(form)) {
      return { core: normalized.slice(0, -form.length), corpForm: form };
    }
  }
  return { core: normalized, corpForm: null };
}

/** 照合キーの生成。異体字を統一し、記号と空白を落として詰める。 */
function toCore(withoutForm: string): string {
  let s = withoutForm;
  for (const [from, to] of VARIANT_KANJI) {
    if (from !== to) s = s.split(from).join(to);
  }
  return s.replace(NOISE_CHARS, '').toLowerCase();
}

/**
 * 商号を正規化する。
 *
 * @example
 *   normalizeCompanyName('㈱ サンプル商事')
 *   // { normalized: '株式会社 サンプル商事', core: 'サンプル商事', corpForm: '株式会社' }
 */
export function normalizeCompanyName(raw: string): NormalizedName {
  const normalized = toNormalized(raw);
  const { core: withoutForm, corpForm } = stripCorpForm(normalized);
  const core = toCore(withoutForm);
  // 法人格しかない商号 (「協同組合」単体など) では core が空になる。
  // 空のキーは名寄せで全件に一致してしまうため、正規化名で埋め戻す。
  return {
    normalized,
    core: core.length > 0 ? core : toCore(normalized),
    corpForm,
  };
}
