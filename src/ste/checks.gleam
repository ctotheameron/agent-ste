import gleam/bool
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/regexp.{type Regexp}
import gleam/result
import gleam/string
import ste/rule.{type Severity, type Violation, Hard, Soft, Violation}
import ste/scan
import ste/segment.{type Paragraph, type Sentence}
import ste/source.{type Line}

/// One regexp check: the pattern, and what to report when it matches.
type Probe {
  Probe(pattern: Regexp, rule_id: String, message: String, severity: Severity)
}

/// Every verb and style regexp, compiled once.
pub opaque type Patterns {
  Patterns(probes: List(Probe))
}

const be = "(?:am|is|are|was|were|be|been|being)"

/// An irregular past participle does not end in "ed", so list the common ones.
/// Adapted from Ryuketsukami/ste-plain-writing (MIT).
const irregular = "(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)"

/// `'s` is the only ambiguous case. `repo's` is a possessive, not a
/// contraction, so a bare `\w+'s` rule reports a false positive. Only this
/// fixed set of stems forms a real `'s` contraction.
const contraction_s_stems = "(?:it|he|she|that|what|who|there|here|let|one|where|how|everyone|everybody|something|nothing|somebody|nobody)"

const contraction_rule = "style/contraction"

const contraction_advice = "Do not use a contraction. Write the words in full."

pub fn patterns() -> Result(Patterns, Nil) {
  use progressive <- result.try(compile(be <> "\\s+\\w+ing\\b"))
  use perfect <- result.try(compile(participle("(?:have|has|had)")))
  use passive <- result.try(compile(participle(be)))
  use contraction <- result.try(compile("\\w+['\u{2019}](?:t|re|ve|ll|d|m)\\b"))
  use contraction_s <- result.try(compile(
    "\\b" <> contraction_s_stems <> "['\u{2019}]s\\b",
  ))

  Ok(
    Patterns([
      Probe(
        progressive,
        "verb/progressive",
        "Use a simple tense. Do not use the progressive.",
        Hard,
      ),
      Probe(
        perfect,
        "verb/perfect",
        "Use the simple past. Do not use the perfect tense.",
        Hard,
      ),
      Probe(
        passive,
        "verb/passive",
        "Use the active voice, unless the actor is unknown.",
        Soft,
      ),
      Probe(contraction, contraction_rule, contraction_advice, Hard),
      Probe(contraction_s, contraction_rule, contraction_advice, Hard),
    ]),
  )
}

fn compile(pattern: String) -> Result(Regexp, Nil) {
  regexp.from_string(pattern)
  |> result.replace_error(Nil)
}

/// An auxiliary verb, then a past participle.
fn participle(auxiliary: String) -> String {
  auxiliary <> "\\s+(?:\\w+ed|" <> irregular <> ")\\b"
}

pub fn verb_forms(patterns: Patterns, line: Line) -> List(Violation) {
  patterns.probes
  |> list.flat_map(matches(_, line))
}

fn matches(probe: Probe, line: Line) -> List(Violation) {
  regexp.scan(probe.pattern, string.lowercase(line.text))
  |> list.map(fn(match) {
    Violation(
      rule_id: probe.rule_id,
      message: probe.message <> " Found: \"" <> match.content <> "\".",
      line: line.number,
      column: scan.first_column(line.text, match.content),
      severity: probe.severity,
    )
  })
}

pub fn semicolon(line: Line) -> List(Violation) {
  scan.columns(line.text, ";")
  |> list.map(fn(column) {
    Violation(
      rule_id: "style/semicolon",
      message: "Do not use a semicolon. Write two sentences.",
      line: line.number,
      column: column,
      severity: Hard,
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
    rule_id: "length/sentence",
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
      rule_id: "length/paragraph",
      message: "This paragraph has "
        <> int.to_string(count)
        <> " sentences. Write no more than "
        <> int.to_string(paragraph_limit)
        <> ".",
      line: paragraph.line,
      column: 1,
      severity: Hard,
    ),
  ]
}
