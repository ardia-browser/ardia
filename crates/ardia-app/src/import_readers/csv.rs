use zeroize::Zeroizing;

use super::Credential;

const URL_KEYS: [&str; 7] = [
    "url",
    "login_uri",
    "website",
    "web site",
    "origin",
    "hostname",
    "login url",
];
const USER_KEYS: [&str; 6] = [
    "username",
    "login_username",
    "login",
    "user",
    "email",
    "user name",
];
const PASS_KEYS: [&str; 3] = ["password", "login_password", "pass"];

pub fn rows(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text
        .strip_prefix('\u{FEFF}')
        .unwrap_or(text)
        .chars()
        .peekable();
    let end_row = |row: &mut Vec<String>, field: &mut String, rows: &mut Vec<Vec<String>>| {
        row.push(std::mem::take(field));
        let taken = std::mem::take(row);
        if !(taken.len() == 1 && taken[0].is_empty()) {
            rows.push(taken);
        }
    };
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                end_row(&mut row, &mut field, &mut rows);
            }
            '\n' => end_row(&mut row, &mut field, &mut rows),
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        end_row(&mut row, &mut field, &mut rows);
    }
    rows
}

pub fn passwords(text: &str) -> Result<Vec<Credential>, String> {
    let all = rows(text);
    let header: Vec<String> = all
        .first()
        .ok_or("The file is empty")?
        .iter()
        .map(|h| h.trim().to_lowercase())
        .collect();
    let column = |keys: &[&str]| keys.iter().find_map(|k| header.iter().position(|h| h == k));
    let (Some(url), Some(pass)) = (column(&URL_KEYS), column(&PASS_KEYS)) else {
        return Err("This CSV doesn't have url and password columns".into());
    };
    let user = column(&USER_KEYS);
    let realm = header.iter().position(|h| h == "httprealm");
    let field = |row: &Vec<String>, i: Option<usize>| {
        i.and_then(|i| row.get(i))
            .filter(|v| !v.is_empty())
            .cloned()
    };
    Ok(all
        .iter()
        .skip(1)
        .filter_map(|row| {
            let site = field(row, Some(url))?;
            let password = field(row, Some(pass))?;
            Some(Credential {
                url: site,
                username: field(row, user).unwrap_or_default(),
                password: Zeroizing::new(password),
                realm: field(row, realm),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_fields_keep_commas_quotes_and_newlines() {
        let parsed = rows("\u{FEFF}a,b\r\n\"x,\"\"y\"\"\",\"line\nnext\"\n\n");
        assert_eq!(
            parsed,
            vec![
                vec!["a".to_owned(), "b".to_owned()],
                vec!["x,\"y\"".to_owned(), "line\nnext".to_owned()]
            ]
        );
    }

    #[test]
    fn safari_passwords_export_reads() {
        let text = std::fs::read_to_string(crate::import_readers::fixture(
            "safari/Safari Export/Passwords.csv",
        ))
        .unwrap();
        let creds = passwords(&text).unwrap();
        assert_eq!(creds[0].url, "https://apple.example/");
        assert_eq!(creds[0].username, "me@example.com");
        assert_eq!(creds[0].password.as_str(), "pa,ss\"word");
        assert!(passwords("name,note\nx,y").is_err());
        assert!(passwords("").is_err());
    }
}
