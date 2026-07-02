// 최소 JSON 파서/직렬화기 — 외부 의존성 없이 settings.json 류 소형 설정 파일을
// 안전하게 읽고 쓴다. 객체 키 순서를 보존하고 숫자는 원문 토큰을 유지해
// 라운드트립이 사용자 파일의 의미를 바꾸지 않게 한다.

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// 원문 토큰 그대로 보존 (재직렬화 시 포맷 드리프트 방지)
    Number(String),
    String(String),
    Array(Vec<Value>),
    /// 삽입 순서 보존
    Object(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        match self {
            Value::Object(entries) => entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// 객체에 키 설정 — 있으면 교체(위치 보존), 없으면 끝에 추가.
    pub fn set(&mut self, key: &str, val: Value) {
        if let Value::Object(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some((_, v)) => *v = val,
                None => entries.push((key.to_string(), val)),
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        if let Value::Object(entries) = self {
            if let Some(i) = entries.iter().position(|(k, _)| k == key) {
                return Some(entries.remove(i).1);
            }
        }
        None
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn is_empty_object(&self) -> bool {
        matches!(self, Value::Object(e) if e.is_empty())
    }
}

pub fn parse(input: &str) -> Result<Value, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut p = Parser { chars, pos: 0 };
    p.skip_ws();
    let v = p.value()?;
    p.skip_ws();
    if p.pos != p.chars.len() {
        return Err(format!("JSON 뒤에 여분 문자가 있습니다 (위치 {})", p.pos));
    }
    Ok(v)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(' ' | '\t' | '\n' | '\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, c: char) -> Result<(), String> {
        match self.next() {
            Some(got) if got == c => Ok(()),
            got => Err(format!("'{c}' 필요 (위치 {}, 발견 {:?})", self.pos, got)),
        }
    }

    fn literal(&mut self, word: &str, val: Value) -> Result<Value, String> {
        for c in word.chars() {
            self.expect(c)?;
        }
        Ok(val)
    }

    fn value(&mut self) -> Result<Value, String> {
        self.skip_ws();
        match self.peek() {
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => Ok(Value::String(self.string()?)),
            Some('t') => self.literal("true", Value::Bool(true)),
            Some('f') => self.literal("false", Value::Bool(false)),
            Some('n') => self.literal("null", Value::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            got => Err(format!("값 필요 (위치 {}, 발견 {:?})", self.pos, got)),
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.expect('{')?;
        let mut entries = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(Value::Object(entries));
        }
        loop {
            self.skip_ws();
            let key = self.string()?;
            self.skip_ws();
            self.expect(':')?;
            let val = self.value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.next() {
                Some(',') => continue,
                Some('}') => return Ok(Value::Object(entries)),
                got => {
                    return Err(format!(
                        "',' 또는 '}}' 필요 (위치 {}, 발견 {:?})",
                        self.pos, got
                    ))
                }
            }
        }
    }

    fn array(&mut self) -> Result<Value, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_ws();
            match self.next() {
                Some(',') => continue,
                Some(']') => return Ok(Value::Array(items)),
                got => {
                    return Err(format!(
                        "',' 또는 ']' 필요 (위치 {}, 발견 {:?})",
                        self.pos, got
                    ))
                }
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut s = String::new();
        loop {
            match self.next() {
                None => return Err("문자열이 닫히지 않았습니다".into()),
                Some('"') => return Ok(s),
                Some('\\') => match self.next() {
                    Some('"') => s.push('"'),
                    Some('\\') => s.push('\\'),
                    Some('/') => s.push('/'),
                    Some('b') => s.push('\u{0008}'),
                    Some('f') => s.push('\u{000C}'),
                    Some('n') => s.push('\n'),
                    Some('r') => s.push('\r'),
                    Some('t') => s.push('\t'),
                    Some('u') => {
                        let hi = self.hex4()?;
                        let code = if (0xD800..0xDC00).contains(&hi) {
                            // surrogate pair
                            self.expect('\\')?;
                            self.expect('u')?;
                            let lo = self.hex4()?;
                            if !(0xDC00..0xE000).contains(&lo) {
                                return Err("잘못된 서로게이트 페어".into());
                            }
                            0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                        } else {
                            hi
                        };
                        s.push(char::from_u32(code).ok_or("잘못된 유니코드 이스케이프")?);
                    }
                    got => return Err(format!("잘못된 이스케이프 (위치 {}, {:?})", self.pos, got)),
                },
                Some(c) if (c as u32) < 0x20 => {
                    return Err(format!("문자열 내 제어문자 (위치 {})", self.pos))
                }
                Some(c) => s.push(c),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut code = 0u32;
        for _ in 0..4 {
            let c = self.next().ok_or("\\u 뒤 16진수 4자리 필요")?;
            code = code * 16 + c.to_digit(16).ok_or(format!("잘못된 16진수 '{c}'"))?;
        }
        Ok(code)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek() == Some('.') {
            self.pos += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        let tok: String = self.chars[start..self.pos].iter().collect();
        if tok.is_empty() || tok == "-" {
            return Err(format!("잘못된 숫자 (위치 {start})"));
        }
        Ok(Value::Number(tok))
    }
}

pub fn to_pretty(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v, 0);
    out.push('\n');
    out
}

fn write_value(out: &mut String, v: &Value, indent: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(n),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&"  ".repeat(indent + 1));
                write_value(out, item, indent + 1);
            }
            out.push('\n');
            out.push_str(&"  ".repeat(indent));
            out.push(']');
        }
        Value::Object(entries) => {
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&"  ".repeat(indent + 1));
                write_string(out, k);
                out.push_str(": ");
                write_value(out, val, indent + 1);
            }
            out.push('\n');
            out.push_str(&"  ".repeat(indent));
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_order_and_numbers() {
        let src = r#"{
  "b": 1,
  "a": 2.50,
  "neg": -3e-2,
  "s": "한글 \"quote\" \n",
  "arr": [true, false, null],
  "nested": {"x": {}}
}"#;
        let v = parse(src).unwrap();
        let out = to_pretty(&v);
        // 키 순서 보존
        assert!(out.find("\"b\"").unwrap() < out.find("\"a\"").unwrap());
        // 숫자 원문 토큰 보존 (2.50 이 2.5 로 뭉개지지 않음)
        assert!(out.contains("2.50"));
        assert!(out.contains("-3e-2"));
        // 재파싱 동등성
        assert_eq!(parse(&out).unwrap(), v);
    }

    #[test]
    fn unicode_escapes() {
        let v = parse(r#""😀 A""#).unwrap();
        assert_eq!(v, Value::String("😀 A".into()));
    }

    #[test]
    fn rejects_trailing_garbage_and_bad_input() {
        assert!(parse("{} x").is_err());
        assert!(parse("{").is_err());
        assert!(parse(r#"{"a" 1}"#).is_err());
        assert!(parse("-").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn object_helpers() {
        let mut v = parse(r#"{"env": {"A": "1"}}"#).unwrap();
        let env = v.get_mut("env").unwrap();
        env.set("B", Value::String("2".into()));
        env.set("A", Value::String("changed".into()));
        assert_eq!(env.get("A").and_then(Value::as_str), Some("changed"));
        assert_eq!(
            env.remove("A").and_then(|x| x.as_str().map(String::from)),
            Some("changed".into())
        );
        assert_eq!(env.get("A"), None);
        assert!(!env.is_empty_object());
        env.remove("B");
        assert!(env.is_empty_object());
    }

    #[test]
    fn control_chars_escaped_on_write() {
        let out = to_pretty(&Value::String("a\u{0001}b".into()));
        assert!(out.contains("\\u0001"));
    }
}
