#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// Coordinates use AppKit's bottom-left origin; keep the top edge when shrinking.
pub fn playback_frame(previous: Frame, area: Option<Frame>, preferred_width: f64, center: bool) -> Frame {
    let width = area.map(|area| preferred_width.min((area.width - 48.0).max(1.0))
        .min((area.height - 48.0).max(1.0) * 16.0 / 9.0)).unwrap_or(preferred_width);
    let height = width * 9.0 / 16.0;
    let (x, y) = match area.filter(|_| center) {
        Some(area) => (area.x + (area.width - width) / 2.0, area.y + (area.height - height) / 2.0),
        None => (previous.x, previous.y + previous.height - height),
    };
    Frame { x, y, width, height }
}

// Anchor the mini player’s top-right corner at the pointer, keeping it inside the usable screen.
pub fn frame_at_pointer(mut frame: Frame, area: Option<Frame>, x: f64, y: f64) -> Frame {
    frame.x = x - frame.width;
    frame.y = y - frame.height;
    if let Some(area) = area {
        frame.x = frame.x.clamp(area.x, (area.x + area.width - frame.width).max(area.x));
        frame.y = frame.y.clamp(area.y, (area.y + area.height - frame.height).max(area.y));
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Frame { Frame { x: 0.0, y: 40.0, width: 1600.0, height: 900.0 } }
    fn previous() -> Frame { Frame { x: 900.0, y: 40.0, width: 640.0, height: 360.0 } }

    #[test]
    fn returning_from_corner_centers_and_restores_user_width() {
        let frame = playback_frame(previous(), Some(area()), 1440.0, true);
        assert_eq!(frame, Frame { x: 80.0, y: 85.0, width: 1440.0, height: 810.0 });
    }

    #[test]
    fn entering_mini_keeps_the_top_left_and_sixteen_nine() {
        let old = Frame { x: 80.0, y: 85.0, width: 1440.0, height: 810.0 };
        assert_eq!(playback_frame(old, Some(area()), 640.0, false),
            Frame { x: 80.0, y: 535.0, width: 640.0, height: 360.0 });
    }

    #[test]
    fn short_screens_fit_uniformly_without_distorting_aspect() {
        let area = Frame { x: 0.0, y: 0.0, width: 1920.0, height: 600.0 };
        let frame = playback_frame(previous(), Some(area), 1440.0, true);
        assert!((frame.height - 552.0).abs() < 0.00001);
        assert!((frame.width / frame.height - 16.0 / 9.0).abs() < 0.00001);
        assert!(frame.x >= area.x && frame.y >= area.y);
    }

    #[test]
    fn secondary_screen_negative_origin_is_preserved() {
        let area = Frame { x: -1920.0, y: -600.0, width: 1920.0, height: 1080.0 };
        let frame = playback_frame(previous(), Some(area), 1200.0, true);
        assert_eq!(frame, Frame { x: -1560.0, y: -397.5, width: 1200.0, height: 675.0 });
    }

    #[test]
    fn absent_screen_preserves_top_left_instead_of_jumping_to_origin() {
        let frame = playback_frame(previous(), None, 1200.0, true);
        assert_eq!(frame.x, previous().x);
        assert_eq!(frame.y + frame.height, previous().y + previous().height);
    }
}

#[cfg(test)]
mod pointer_tests {
    use super::*;
    #[test]
    fn pointer_anchors_top_right_and_clamps_at_screen_edges() {
        let area = Frame { x: -1600.0, y: 40.0, width: 1600.0, height: 900.0 };
        let size = Frame { x: 0.0, y: 0.0, width: 640.0, height: 360.0 };
        let middle = frame_at_pointer(size, Some(area), -800.0, 490.0);
        assert_eq!((middle.x, middle.y), (-1440.0, 130.0));
        let corner = frame_at_pointer(size, Some(area), -10.0, 930.0);
        assert_eq!((corner.x, corner.y), (-650.0, 570.0));
        let corner = frame_at_pointer(size, Some(area), -1590.0, 45.0);
        assert_eq!((corner.x, corner.y), (-1600.0, 40.0));
    }
}
