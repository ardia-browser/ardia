fn round_half_toward_zero(value: f32) -> f32 {
    (value.abs() - 0.5).ceil().copysign(value)
}

pub fn half_up_nudge(offset: f32, scale: f32) -> f32 {
    if !(offset.is_finite() && scale.is_finite() && scale > 0.0) {
        return 0.0;
    }
    let device = offset * scale;
    ((device + 0.5).floor() - round_half_toward_zero(device)) / scale
}

pub fn centred_nudge(container: f32, item: f32, scale: f32) -> f32 {
    2.0 * half_up_nudge((container - item) / 2.0, scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ties_land_on_the_device_pixel_the_old_layout_rounded_to() {
        assert_eq!(half_up_nudge(25.75, 2.0), 0.5);
        assert_eq!(half_up_nudge(25.25, 2.0), 0.5);
        assert_eq!(half_up_nudge(25.5, 2.0), 0.0);
        assert_eq!(half_up_nudge(25.6, 2.0), 0.0);
        assert_eq!(half_up_nudge(3.5, 1.0), 1.0);
        assert_eq!(half_up_nudge(f32::NAN, 2.0), 0.0);
        assert_eq!(half_up_nudge(4.0, 0.0), 0.0);
        assert_eq!(centred_nudge(67.5, 16.0, 2.0), 1.0);
        assert_eq!(centred_nudge(68.0, 16.0, 2.0), 0.0);
    }
}
