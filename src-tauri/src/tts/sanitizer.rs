/// Sanitizes text intended for speech synthesis.
///
/// Rules:
/// - Removes control characters (ASCII 0..=31, 127, and unicode format/control chars).
/// - Collapses repeated whitespace into a single space.
/// - Trims leading and trailing whitespace.
/// - Caps text at a maximum character length (default 300) to prevent abuse or excessive synthesis times.
pub fn sanitize_speech_text(text: &str, max_len: usize) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut last_was_space = false;

    for ch in text.chars() {
        if ch.is_control() {
            // Replace any whitespace control character (tab, newline) with space
            if ch.is_whitespace() {
                if !last_was_space {
                    cleaned.push(' ');
                    last_was_space = true;
                }
            }
            continue;
        }

        if ch.is_whitespace() {
            if !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
        } else {
            cleaned.push(ch);
            last_was_space = false;
        }
    }

    let trimmed = cleaned.trim();
    if trimmed.chars().count() > max_len {
        trimmed.chars().take(max_len).collect::<String>().trim_end().to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_collapses_whitespace() {
        let input = "  Good   morning,   \t\n  Ada  Lovelace!  ";
        let output = sanitize_speech_text(input, 300);
        assert_eq!(output, "Good morning, Ada Lovelace!");
    }

    #[test]
    fn removes_non_whitespace_control_characters() {
        let input = "Hello\x00\x07\x1B[31m World\x7F!";
        let output = sanitize_speech_text(input, 300);
        assert_eq!(output, "Hello[31m World!");
    }

    #[test]
    fn enforces_maximum_length() {
        let input = "a".repeat(400);
        let output = sanitize_speech_text(&input, 100);
        assert_eq!(output.len(), 100);
    }

    #[test]
    fn handles_empty_or_whitespace_only() {
        assert_eq!(sanitize_speech_text("", 300), "");
        assert_eq!(sanitize_speech_text("   \t\n  ", 300), "");
    }
}
