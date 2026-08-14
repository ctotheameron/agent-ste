import gleam/bool
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp.{type Regexp}
import gleam/result
import gleam/string
import ste/rule.{type Id, type Severity, type Violation, Hard, Soft, Violation}
import ste/scan
import ste/segment.{type Paragraph, type Sentence}
import ste/source.{type Line}

/// One row of the check table: what to look for, and what to report. A rule
/// takes more than one pattern when one regexp cannot state it.
type Check(pattern) {
  Check(patterns: List(pattern), id: Id, advice: String)
}

type Spec =
  Check(String)

type Probe =
  Check(Regexp)

/// Every verb and style regexp, compiled once.
pub opaque type Patterns {
  Patterns(probes: List(Probe))
}

/// A form of `be`, at the start of a word.
///
/// The boundary carries the rule. Without it, the `is` inside `this` matches,
/// and `this morning` reports a progressive verb. `his meeting` and `axis
/// rotating` fall the same way, and each one blocks a write.
const be = "\\b(?:am|is|are|was|were|be|been|being)"

/// An irregular past participle does not end in "ed", so list the common ones.
/// Adapted from Ryuketsukami/ste-plain-writing (MIT).
const irregular = "(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)"

/// `'s` is the only ambiguous case. `repo's` is a possessive, not a
/// contraction, so a bare `\w+'s` rule reports a false positive. Only this
/// fixed set of stems forms a real `'s` contraction.
const contraction_s_stems = "(?:it|he|she|that|what|who|there|here|let|one|where|how|everyone|everybody|something|nothing|somebody|nobody)"

/// A word that carries a verb ending but states no action.
///
/// Each verb rule matches an auxiliary, then a word that ends in `ing` or
/// `ed`. That shape also fits `the file is missing`, where the second word
/// describes. A part-of-speech tagger tells the two apart, and this engine
/// holds none. A count over 402,000 words of real prose chose these words, and
/// `running` stays out. A false report blocks a write, so the list takes the
/// safer error.
const not_a_verb = [
  // A noun or a pronoun that ends in `ing`.
  "nothing", "something", "anything", "everything", "string", "warning",
  "meaning", "spelling", "wording", "heading",
  // An adjective that ends in `ing`.
  "missing", "pending", "confusing", "interesting", "existing", "remaining",
  "outstanding", "ongoing", "upcoming", "incoming", "outgoing", "underlying",
  "noncapturing", "breaking", "willing",
  // An adjective that ends in `ed`.
  "advanced", "limited", "detailed", "related", "dedicated", "complicated",
  "sophisticated", "deprecated", "mixed", "varied",
]

/// Every regexp rule, one row each. A row pairs its patterns with the rule and
/// the advice to report. The rule gives the severity.
fn table() -> List(Spec) {
  [
    Check(
      [be <> "\\s+\\w+ing\\b"],
      rule.Progressive,
      "Use a simple tense. Do not use the progressive.",
    ),
    Check(
      [participle("\\b(?:have|has|had)")],
      rule.Perfect,
      "Use the simple past. Do not use the perfect tense.",
    ),
    Check(
      [participle(be)],
      rule.Passive,
      "Use the active voice, unless the actor is unknown.",
    ),
    Check(
      [
        "\\w+['\u{2019}](?:t|re|ve|ll|d|m)\\b",
        "\\b" <> contraction_s_stems <> "['\u{2019}]s\\b",
      ],
      rule.Contraction,
      "Do not use a contraction. Write the words in full.",
    ),
  ]
}

/// An auxiliary verb, then a past participle.
fn participle(auxiliary: String) -> String {
  auxiliary <> "\\s+(?:\\w+ed|" <> irregular <> ")\\b"
}

pub fn patterns() -> Result(Patterns, Nil) {
  table()
  |> list.try_map(compile_check)
  |> result.map(Patterns)
}

fn compile_check(spec: Spec) -> Result(Probe, Nil) {
  list.try_map(spec.patterns, compile)
  |> result.map(fn(patterns) { Check(patterns, spec.id, spec.advice) })
}

fn compile(pattern: String) -> Result(Regexp, Nil) {
  regexp.from_string(pattern)
  |> result.replace_error(Nil)
}

pub fn verb_forms(patterns: Patterns, line: Line) -> List(Violation) {
  patterns.probes
  |> list.flat_map(matches(_, line))
}

fn matches(probe: Probe, line: Line) -> List(Violation) {
  probe.patterns
  |> list.flat_map(fn(pattern) { scan_one(pattern, probe, line) })
}

fn scan_one(pattern: Regexp, probe: Probe, line: Line) -> List(Violation) {
  let severity = rule.severity(probe.id)
  regexp.scan(pattern, string.lowercase(line.text))
  |> list.filter(fn(match) { !states_no_action(match.content) })
  |> list.map(fn(match) {
    Violation(
      rule_id: probe.id,
      message: probe.advice <> " Found: \"" <> match.content <> "\".",
      line: line.number,
      column: scan.first_column(line.text, match.content),
      severity: severity,
    )
  })
}

/// True when the last word of a match states no action. The caller lowercases
/// the text, so this compares lowercase only.
fn states_no_action(content: String) -> Bool {
  content
  |> last_word
  |> result.map(list.contains(not_a_verb, _))
  |> result.unwrap(or: False)
}

fn last_word(content: String) -> Result(String, Nil) {
  content
  |> string.replace(each: "\t", with: " ")
  |> string.split(on: " ")
  |> list.filter(fn(word) { word != "" })
  |> list.last
}

pub fn semicolon(line: Line) -> List(Violation) {
  scan.columns(line.text, ";")
  |> list.map(fn(column) {
    Violation(
      rule_id: rule.Semicolon,
      message: "Do not use a semicolon. Write two sentences.",
      line: line.number,
      column: column,
      severity: rule.severity(rule.Semicolon),
    )
  })
}

/// STE caps an instruction sentence at 20 words and a descriptive sentence at
/// 25. A linter cannot reliably tell the two apart, so over 25 is Hard and 21
/// to 25 is Soft.
const instruction_limit = 20

const descriptive_limit = 25

/// The limit a sentence passed, and the advice to report.
type Overflow {
  Overflow(limit: Int, advice: String, severity: Severity)
}

pub fn sentence_length(sentence: Sentence) -> List(Violation) {
  case overflow(sentence.words) {
    None -> []
    Some(over) -> [too_long(sentence, over)]
  }
}

/// This names each severity, because one rule reports both.
fn overflow(words: Int) -> Option(Overflow) {
  case words > descriptive_limit, words > instruction_limit {
    True, _ -> Some(Overflow(descriptive_limit, "Write no more than ", Hard))
    False, True ->
      Some(Overflow(
        instruction_limit,
        "An instruction takes no more than ",
        Soft,
      ))
    False, False -> None
  }
}

fn too_long(sentence: Sentence, over: Overflow) -> Violation {
  Violation(
    rule_id: rule.SentenceLength,
    message: "This sentence has "
      <> int.to_string(sentence.words)
      <> " words. "
      <> over.advice
      <> int.to_string(over.limit)
      <> ".",
    line: sentence.line,
    column: sentence.column,
    severity: over.severity,
  )
}

const paragraph_limit = 6

pub fn paragraph_length(paragraph: Paragraph) -> List(Violation) {
  let count = list.length(paragraph.sentences)
  use <- bool.guard(when: count <= paragraph_limit, return: [])
  [
    Violation(
      rule_id: rule.ParagraphLength,
      message: "This paragraph has "
        <> int.to_string(count)
        <> " sentences. Write no more than "
        <> int.to_string(paragraph_limit)
        <> ".",
      line: paragraph.line,
      column: 1,
      severity: rule.severity(rule.ParagraphLength),
    ),
  ]
}
