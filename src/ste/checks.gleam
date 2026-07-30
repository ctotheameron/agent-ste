import gleam/int
import gleam/list
import gleam/regexp.{type Regexp}
import gleam/string
import ste/rule.{type Violation, Hard, Soft, Violation}
import ste/scan
import ste/segment.{type Paragraph, type Sentence}

/// Compiled once. gleam_regexp reports match content but no offset, so each
/// column comes from `scan.first_column` on the matched text.
pub type Patterns {
  Patterns(
    progressive: Regexp,
    perfect: Regexp,
    passive: Regexp,
    contraction: Regexp,
    contraction_s: Regexp,
  )
}

const be = "(?:am|is|are|was|were|be|been|being)"

/// An irregular past participle does not end in "ed", so list the common ones.
/// Ported from Ryuketsukami/ste-plain-writing (MIT).
const irregular = "(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)"

/// `'s` is the only ambiguous case. "repo's" is a possessive, not a
/// contraction, so a bare `\w+'s` rule reports a false positive. Only this
/// fixed set of stems forms a real `'s` contraction.
const contraction_s_stems = "(?:it|he|she|that|what|who|there|here|let|one|where|how|everyone|everybody|something|nothing|somebody|nobody)"

pub fn patterns() -> Result(Patterns, Nil) {
  case
    regexp.from_string(be <> "\\s+\\w+ing\\b"),
    regexp.from_string("(?:have|has|had)\\s+(?:\\w+ed|" <> irregular <> ")\\b"),
    regexp.from_string(be <> "\\s+(?:\\w+ed|" <> irregular <> ")\\b"),
    regexp.from_string("\\w+['\u{2019}](?:t|re|ve|ll|d|m)\\b"),
    regexp.from_string("\\b" <> contraction_s_stems <> "['\u{2019}]s\\b")
  {
    Ok(progressive),
      Ok(perfect),
      Ok(passive),
      Ok(contraction),
      Ok(contraction_s)
    -> Ok(Patterns(progressive, perfect, passive, contraction, contraction_s))
    _, _, _, _, _ -> Error(Nil)
  }
}

/// STE caps an instruction sentence at 20 words and a descriptive sentence at
/// 25. A linter cannot reliably tell the two apart, so over 25 is Hard and 21
/// to 25 is Soft.
const instruction_limit = 20

const descriptive_limit = 25

pub fn sentence_length(sentence: Sentence) -> List(Violation) {
  case sentence.words > descriptive_limit, sentence.words > instruction_limit {
    True, _ -> [
      Violation(
        rule_id: "length/sentence",
        message: "This sentence has "
          <> int.to_string(sentence.words)
          <> " words. Write no more than "
          <> int.to_string(descriptive_limit)
          <> ".",
        line: sentence.line,
        column: sentence.column,
        severity: Hard,
      ),
    ]
    False, True -> [
      Violation(
        rule_id: "length/sentence",
        message: "This sentence has "
          <> int.to_string(sentence.words)
          <> " words. An instruction takes no more than "
          <> int.to_string(instruction_limit)
          <> ".",
        line: sentence.line,
        column: sentence.column,
        severity: Soft,
      ),
    ]
    False, False -> []
  }
}

const paragraph_limit = 6

pub fn paragraph_length(paragraph: Paragraph) -> List(Violation) {
  let count = list.length(paragraph.sentences)
  case count > paragraph_limit {
    False -> []
    True -> [
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
}

pub fn semicolon(line: String, line_number: Int) -> List(Violation) {
  scan_columns(line, ";")
  |> list.map(fn(column) {
    Violation(
      rule_id: "style/semicolon",
      message: "Do not use a semicolon. Write two sentences.",
      line: line_number,
      column: column,
      severity: Hard,
    )
  })
}

fn scan_columns(line: String, needle: String) -> List(Int) {
  string.split(line, on: needle)
  |> list.fold(#([], 0), fn(state, part) {
    let #(found, position) = state
    #(
      [position + string.length(part) + 1, ..found],
      position + string.length(part) + string.length(needle),
    )
  })
  |> fn(state) {
    // The fold records one column past the final part, which has no needle.
    case state.0 {
      [_, ..rest] -> list.reverse(rest)
      [] -> []
    }
  }
}

pub fn verb_forms(
  patterns: Patterns,
  line: String,
  line_number: Int,
) -> List(Violation) {
  list.flatten([
    matches(
      patterns.progressive,
      line,
      line_number,
      "verb/progressive",
      "Use a simple tense. Do not use the progressive.",
      Hard,
    ),
    matches(
      patterns.perfect,
      line,
      line_number,
      "verb/perfect",
      "Use the simple past. Do not use the perfect tense.",
      Hard,
    ),
    matches(
      patterns.passive,
      line,
      line_number,
      "verb/passive",
      "Use the active voice, unless the actor is unknown.",
      Soft,
    ),
    matches(
      patterns.contraction,
      line,
      line_number,
      "style/contraction",
      "Do not use a contraction. Write the words in full.",
      Hard,
    ),
    matches(
      patterns.contraction_s,
      line,
      line_number,
      "style/contraction",
      "Do not use a contraction. Write the words in full.",
      Hard,
    ),
  ])
}

fn matches(
  pattern: Regexp,
  line: String,
  line_number: Int,
  rule_id: String,
  message: String,
  severity: rule.Severity,
) -> List(Violation) {
  regexp.scan(pattern, string.lowercase(line))
  |> list.map(fn(match) {
    Violation(
      rule_id: rule_id,
      message: message <> " Found: \"" <> match.content <> "\".",
      line: line_number,
      column: scan.first_column(line, match.content),
      severity: severity,
    )
  })
}
