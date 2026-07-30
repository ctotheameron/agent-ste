import gleam/list
import gleam/string

/// Replaces code with spaces and keeps every line and column intact. It blanks
/// a character and never deletes one, so every later line number stays the
/// same.
///
/// Adapted from Ryuketsukami/ste-plain-writing (MIT).
pub fn mask(text: String) -> String {
  string.split(text, on: "\n")
  |> list.fold(#([], False), mask_line)
  |> fn(state) { state.0 }
  |> list.reverse
  |> string.join("\n")
}

fn mask_line(
  state: #(List(String), Bool),
  line: String,
) -> #(List(String), Bool) {
  let #(done, in_fence) = state
  case is_fence(line), in_fence {
    True, _ -> #([blank(line), ..done], !in_fence)
    False, True -> #([blank(line), ..done], True)
    False, False -> #([mask_inline(line), ..done], False)
  }
}

fn is_fence(line: String) -> Bool {
  let trimmed = string.trim_start(line)
  string.starts_with(trimmed, "```") || string.starts_with(trimmed, "~~~")
}

fn blank(line: String) -> String {
  string.repeat(" ", string.length(line))
}

/// Blanks every `inline span` and keeps the line length unchanged.
fn mask_inline(line: String) -> String {
  string.to_graphemes(line)
  |> list.fold(#([], False), fn(state, grapheme) {
    let #(output, inside) = state
    case grapheme, inside {
      "`", _ -> #([" ", ..output], !inside)
      _, True -> #([" ", ..output], True)
      _, False -> #([grapheme, ..output], False)
    }
  })
  |> fn(state) { state.0 }
  |> list.reverse
  |> string.join("")
}
