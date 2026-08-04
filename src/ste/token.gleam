import gleam/bool
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/pair
import gleam/regexp.{type Regexp}
import gleam/result
import gleam/string

pub type Token {
  Token(lower: String, column: Int)
}

/// Compile once and reuse for every line.
pub type Lexer {
  Lexer(pattern: Regexp)
}

/// Group 1 takes the run of non-word characters before a word. Group 2 takes
/// the word. An apostrophe keeps `don't` whole and a hyphen keeps
/// `state-of-the-art` whole.
const word_pattern = "([^a-z0-9_'\u{2019}-]*)([a-z0-9_'\u{2019}-]+)"

pub fn lexer() -> Result(Lexer, Nil) {
  regexp.from_string(word_pattern)
  |> result.map(Lexer)
  |> result.replace_error(Nil)
}

/// Splits a line into word tokens and records the 1-based column of each.
///
/// One native regexp pass does the work. The regexp keeps each separator in a
/// capture group, so a running sum of lengths gives an exact column.
/// gleam_regexp does not report a match offset.
pub fn tokenize(lexer: Lexer, line: String) -> List(Token) {
  regexp.scan(lexer.pattern, string.lowercase(line))
  |> list.map_fold(from: 0, with: take_token)
  |> pair.second
  |> option.values
}

/// Places one match and returns the position where the next one starts.
fn take_token(position: Int, match: regexp.Match) -> #(Int, Option(Token)) {
  case match.submatches {
    [separator, Some(word)] -> {
      let start = position + width(separator)
      let token = Token(lower: word, column: start + 1)
      #(start + string.length(word), Some(token))
    }
    _ -> #(position, None)
  }
}

fn width(text: Option(String)) -> Int {
  text
  |> option.map(string.length)
  |> option.unwrap(or: 0)
}

/// The n-gram of exactly `size` tokens at the head of the list, or an error
/// when the list is too short. A caller tries the longest size first, so a
/// phrase entry like `prior to` beats the single word `prior`.
pub fn ngram_at(tokens: List(Token), size: Int) -> Result(String, Nil) {
  let taken = list.take(tokens, up_to: size)
  use <- bool.guard(when: list.length(taken) != size, return: Error(Nil))
  taken
  |> list.map(fn(token) { token.lower })
  |> string.join(with: " ")
  |> Ok
}
