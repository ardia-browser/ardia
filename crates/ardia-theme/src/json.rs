use serde::Serializer;
use serde_json::Value;

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn is_integral(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= MAX_SAFE_INTEGER
}

pub fn js_number(v: f64) -> Value {
    if is_integral(v) {
        Value::from(v as i64)
    } else if v.is_finite() {
        Value::from(v)
    } else {
        Value::Null
    }
}

pub fn serialize_f64<S: Serializer>(v: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if is_integral(*v) {
        serializer.serialize_i64(*v as i64)
    } else if v.is_finite() {
        serializer.serialize_f64(*v)
    } else {
        serializer.serialize_unit()
    }
}

pub fn serialize_f32<S: Serializer>(v: &f32, serializer: S) -> Result<S::Ok, S::Error> {
    serialize_f64(&f64::from(*v), serializer)
}

pub fn serialize_option_f64<S: Serializer>(
    v: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match v {
        Some(v) => serialize_f64(v, serializer),
        None => serializer.serialize_unit(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_floats_print_like_javascript() {
        assert_eq!(js_number(5.0).to_string(), "5");
        assert_eq!(js_number(-0.0).to_string(), "0");
        assert_eq!(js_number(0.5).to_string(), "0.5");
        assert_eq!(js_number(f64::NAN), Value::Null);
        assert_eq!(js_number(1e300).to_string(), "1e+300");
        assert_eq!(js_number(1795624452665.0).to_string(), "1795624452665");
    }
}
