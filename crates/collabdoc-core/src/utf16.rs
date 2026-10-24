//! The editor (Qt) counts UTF-16 code units; Loro offers `*_utf16` APIs for that.

pub fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

pub fn len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_low_surrogate(u: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&u)
}

/// Common prefix and suffix lengths of `a` and `b`, never splitting a surrogate pair.
pub fn common_affixes(a: &[u16], b: &[u16]) -> (usize, usize) {
    let max = a.len().min(b.len());
    let mut prefix = 0;
    while prefix < max && a[prefix] == b[prefix] {
        prefix += 1;
    }
    while prefix > 0 && prefix < a.len().max(b.len()) && {
        let next_a = a.get(prefix).copied().is_some_and(is_low_surrogate);
        let next_b = b.get(prefix).copied().is_some_and(is_low_surrogate);
        next_a || next_b
    } {
        prefix -= 1;
    }
    let mut suffix = 0;
    while suffix < max - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }
    while suffix > 0 && {
        let first_a = a
            .get(a.len() - suffix)
            .copied()
            .is_some_and(is_low_surrogate);
        let first_b = b
            .get(b.len() - suffix)
            .copied()
            .is_some_and(is_low_surrogate);
        first_a || first_b
    } {
        suffix -= 1;
    }
    (prefix, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affixes_of_plain_edits() {
        assert_eq!(common_affixes(&units("hello"), &units("help")), (3, 0));
        assert_eq!(common_affixes(&units("abc"), &units("abXc")), (2, 1));
        assert_eq!(common_affixes(&units("aaa"), &units("aaaa")), (3, 0));
        assert_eq!(common_affixes(&units(""), &units("x")), (0, 0));
    }

    #[test]
    fn never_splits_a_surrogate_pair() {
        // 😀 = D83D DE00, 😁 = D83D DE01: they share the high surrogate.
        let (p, s) = common_affixes(&units("a😀b"), &units("a😁b"));
        assert_eq!((p, s), (1, 1));
    }
}
