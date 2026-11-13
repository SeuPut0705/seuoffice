//! `nativeImage.createFromBuffer(bytes)` for the slides AI: decodes the bytes
//! of a picture (PNG, JPEG, GIF, WebP, BMP) with the `image` crate. What the
//! handlers read of the result: whether it is empty (the bytes are no picture),
//! its size, and its PNG.

use std::io::Cursor;

use image::{DynamicImage, ImageFormat};
use main_core::slides::ai_ipc::{ImageDecoder, NativeImage};

/// A decoded picture, or nothing where the bytes did not decode
struct Picture(Option<DynamicImage>);

impl NativeImage for Picture {
    fn is_empty(&self) -> bool {
        self.0.is_none()
    }

    /// `toPNG()`: empty for an empty image
    fn to_png(&self) -> Vec<u8> {
        let Some(image) = &self.0 else {
            return Vec::new();
        };
        let mut png = Cursor::new(Vec::new());
        match image.write_to(&mut png, ImageFormat::Png) {
            Ok(()) => png.into_inner(),
            Err(_) => Vec::new(),
        }
    }

    /// `getSize()`: `{ width: 0, height: 0 }` for an empty image
    fn size(&self) -> (f64, f64) {
        self.0.as_ref().map_or((0.0, 0.0), |image| {
            (f64::from(image.width()), f64::from(image.height()))
        })
    }
}

pub struct Decoder;

impl ImageDecoder for Decoder {
    fn create_from_buffer(&self, bytes: &[u8]) -> Box<dyn NativeImage> {
        Box::new(Picture(image::load_from_memory(bytes).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    /// A 3 x 2 picture encoded as `format`
    fn encoded(format: ImageFormat) -> Vec<u8> {
        let picture = DynamicImage::ImageRgb8(RgbImage::from_pixel(3, 2, Rgb([200, 40, 40])));
        let mut bytes = Cursor::new(Vec::new());
        picture.write_to(&mut bytes, format).expect("encodes");
        bytes.into_inner()
    }

    #[test]
    fn a_png_and_a_jpeg_decode_to_their_size_and_a_png() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg] {
            let image = Decoder.create_from_buffer(&encoded(format));
            assert!(!image.is_empty(), "{format:?}");
            assert_eq!(image.size(), (3.0, 2.0), "{format:?}");
            let png = image.to_png();
            assert_eq!(
                image::guess_format(&png).expect("a format"),
                ImageFormat::Png
            );
            let again = image::load_from_memory(&png).expect("the PNG decodes");
            assert_eq!((again.width(), again.height()), (3, 2));
        }
    }

    #[test]
    fn bytes_that_are_no_picture_are_an_empty_image() {
        for bytes in [
            &b""[..],
            &b"not a picture"[..],
            &encoded(ImageFormat::Png)[..20],
        ] {
            let image = Decoder.create_from_buffer(bytes);
            assert!(image.is_empty());
            assert_eq!(image.size(), (0.0, 0.0));
            assert!(image.to_png().is_empty());
        }
    }
}
