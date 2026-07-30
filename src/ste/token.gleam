import gleam/list
import gleam/option.{Some}
import gleam/regexp.{type Regexp}
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
  case regexp.from_string(word_pattern) {
    Ok(pattern) -> Ok(Lexer(pattern))
    Error(_) -> Error(Nil)
  }
}

/// Splits a line into word tokens and records the 1-based column of each.
///
/// One native regexp pass does the work. The regexp keeps each separator in a
/// capture group, so a running sum of lengths gives an exact column.
/// gleam_regexp does not report a match offset.
pub fn tokenize(lexer: Lexer, line: String) -> List(Token) {
  regexp.scan(lexer.pattern, string.lowercase(line))
  |> list.fold(#([], 0), fn(state, match) {
    let #(done, position) = state
    case match.submatches {
      [separator, Some(word)] -> {
        let start = position + separator_length(separator)
        #(
          [Token(lower: word, column: start + 1), ..done],
          start + string.length(word),
        )
      }
      _ -> #(done, position)
    }
  })
  |> fn(state) { list.reverse(state.0) }
}

fn separator_length(separator: option.Option(String)) -> Int {
  case separator {
    Some(text) -> string.length(text)
    _ -> 0
  }
}

/// The n-gram of exactly `size` tokens at the head of the list, or an error
/// when the list is too short. A caller tries the longest size first, so a
/// phrase entry like `prior to` beats the single word `prior`.
pub fn ngram_at(tokens: List(Token), size: Int) -> Result(String, Nil) {
  let taken = list.take(tokens, size)
  case list.length(taken) == size {
    False -> Error(Nil)
    True -> Ok(list.map(taken, fn(token) { token.lower }) |> string.join(" "))
  }
}
