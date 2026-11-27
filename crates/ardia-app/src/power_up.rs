use std::sync::Arc;

use ardia_ui::ntp::power_up::{PowerUpFrame, PowerUpRequest};
use parking_lot::Mutex;

pub const PAGE_SCALE: f32 = 0.25;
pub const HALO_SCALE: f32 = 2.0;
pub const PAGE_BLUR_POINTS: f32 = 24.0;
pub const FRAME_SECONDS: f32 = 1.0 / 60.0;
pub const HALO_DELAY: f32 = 0.18;
pub const HALO_FADE_START: f32 = 1.0;
pub const HALO_FADE_DURATION: f32 = 0.2;
pub const PAGE_DELAY: f32 = 0.0;
pub const PAGE_FADE_START: f32 = 1.0;
pub const PAGE_FADE_DURATION: f32 = 2.0;

struct Running {
    key: String,
    latest: Arc<Mutex<PowerUpFrame>>,
}

static PLAYER: Mutex<Option<Running>> = Mutex::new(None);

pub fn oklab([r, g, b, a]: [f32; 4]) -> [f32; 4] {
    let lin = |x: f32| {
        if x <= 0.04045 {
            x / 12.92
        } else {
            ((x + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(r), lin(g), lin(b));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
        a,
    ]
}

pub fn halo_colors(palette: &[[f32; 4]]) -> [[f32; 4]; 2] {
    let first = palette
        .first()
        .copied()
        .unwrap_or([1.0, 0.5176, 0.3098, 1.0]);
    [first, palette.get(1).copied().unwrap_or(first)]
}

pub fn frame(request: &PowerUpRequest) -> Option<PowerUpFrame> {
    let mut player = PLAYER.lock();
    if let Some(running) = player.as_ref()
        && running.key == request.key
    {
        return Some(running.latest.lock().clone());
    }
    let latest = Arc::new(Mutex::new(PowerUpFrame::default()));
    if !start(request.clone(), Arc::clone(&latest)) {
        return None;
    }
    *player = Some(Running {
        key: request.key.clone(),
        latest: Arc::clone(&latest),
    });
    let shown = latest.lock().clone();
    Some(shown)
}

#[cfg(target_os = "macos")]
fn start(request: PowerUpRequest, latest: Arc<Mutex<PowerUpFrame>>) -> bool {
    std::thread::Builder::new()
        .name("ardia-power-up".into())
        .spawn(move || metal::play(&request, &latest))
        .is_ok()
}

#[cfg(not(target_os = "macos"))]
fn start(request: PowerUpRequest, latest: Arc<Mutex<PowerUpFrame>>) -> bool {
    let _ = request;
    latest.lock().done = true;
    true
}

#[cfg(target_os = "macos")]
mod metal {
    use std::ptr::NonNull;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use ardia_ui::ntp::power_up::{
        HALO_INSET, HALO_SECONDS, PAGE_SECONDS, PowerUpFrame, PowerUpRequest,
    };
    use gpui::RenderImage;
    use image::{Frame, RgbaImage};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::NSString;
    use objc2_metal::{
        MTLBlendFactor, MTLClearColor, MTLCommandBuffer, MTLCommandEncoder, MTLCommandQueue,
        MTLCreateSystemDefaultDevice, MTLDevice, MTLLibrary, MTLLoadAction, MTLOrigin,
        MTLPixelFormat, MTLPrimitiveType, MTLRegion, MTLRenderCommandEncoder,
        MTLRenderPassDescriptor, MTLRenderPipelineDescriptor, MTLRenderPipelineState, MTLSize,
        MTLStorageMode, MTLStoreAction, MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
    };
    use parking_lot::Mutex;

    use super::*;

    type Device = Retained<ProtocolObject<dyn MTLDevice>>;
    type Queue = Retained<ProtocolObject<dyn MTLCommandQueue>>;
    type Pipeline = Retained<ProtocolObject<dyn MTLRenderPipelineState>>;
    type Texture = Retained<ProtocolObject<dyn MTLTexture>>;

    struct Renderer {
        device: Device,
        queue: Queue,
        page: Pipeline,
        halo: Pipeline,
        blur: Pipeline,
    }

    const SOURCE: &str = concat!(
        include_str!("power_up/fullscreen.metal"),
        include_str!("power_up/halo.metal"),
        include_str!("power_up/power_up.metal"),
        include_str!("power_up/blur.metal"),
    );

    fn pipeline(
        device: &Device,
        library: &ProtocolObject<dyn MTLLibrary>,
        fragment: &str,
        premultiplied: bool,
    ) -> Option<Pipeline> {
        let vertex = library.newFunctionWithName(&NSString::from_str("fullscreenVertex"))?;
        let fragment = library.newFunctionWithName(&NSString::from_str(fragment))?;
        let desc = MTLRenderPipelineDescriptor::new();
        desc.setVertexFunction(Some(&vertex));
        desc.setFragmentFunction(Some(&fragment));
        let attachment = unsafe { desc.colorAttachments().objectAtIndexedSubscript(0) };
        attachment.setPixelFormat(MTLPixelFormat::BGRA8Unorm);
        attachment.setBlendingEnabled(true);
        attachment.setSourceRGBBlendFactor(if premultiplied {
            MTLBlendFactor::One
        } else {
            MTLBlendFactor::SourceAlpha
        });
        attachment.setDestinationRGBBlendFactor(MTLBlendFactor::OneMinusSourceAlpha);
        attachment.setSourceAlphaBlendFactor(MTLBlendFactor::One);
        attachment.setDestinationAlphaBlendFactor(MTLBlendFactor::OneMinusSourceAlpha);
        device
            .newRenderPipelineStateWithDescriptor_error(&desc)
            .ok()
    }

    impl Renderer {
        fn new() -> Option<Self> {
            let device = MTLCreateSystemDefaultDevice()?;
            let queue = device.newCommandQueue()?;
            let library = device
                .newLibraryWithSource_options_error(&NSString::from_str(SOURCE), None)
                .map_err(|problem| log::warn!("power-up shaders didn't compile: {problem:?}"))
                .ok()?;
            Some(Renderer {
                page: pipeline(&device, &library, "powerUpFragment", true)?,
                halo: pipeline(&device, &library, "haloFragment", true)?,
                blur: pipeline(&device, &library, "blurFragment", true)?,
                device,
                queue,
            })
        }

        fn texture(&self, width: usize, height: usize) -> Option<Texture> {
            let desc = unsafe {
                MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                    MTLPixelFormat::BGRA8Unorm,
                    width,
                    height,
                    false,
                )
            };
            desc.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
            desc.setStorageMode(MTLStorageMode::Shared);
            self.device.newTextureWithDescriptor(&desc)
        }

        fn pass(
            &self,
            target: &Texture,
            pipeline: &Pipeline,
            bind: impl FnOnce(&ProtocolObject<dyn MTLRenderCommandEncoder>),
        ) -> Option<()> {
            let pass = MTLRenderPassDescriptor::renderPassDescriptor();
            let color = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
            color.setTexture(Some(target));
            color.setLoadAction(MTLLoadAction::Clear);
            color.setClearColor(MTLClearColor {
                red: 0.0,
                green: 0.0,
                blue: 0.0,
                alpha: 0.0,
            });
            color.setStoreAction(MTLStoreAction::Store);
            let buffer = self.queue.commandBuffer()?;
            let encoder = buffer.renderCommandEncoderWithDescriptor(&pass)?;
            encoder.setRenderPipelineState(pipeline);
            bind(&encoder);
            unsafe {
                encoder.drawPrimitives_vertexStart_vertexCount(
                    MTLPrimitiveType::TriangleStrip,
                    0,
                    4,
                )
            };
            encoder.endEncoding();
            buffer.commit();
            buffer.waitUntilCompleted();
            Some(())
        }
    }

    fn bytes<T>(encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>, value: &T, index: usize) {
        if let Some(pointer) = NonNull::new(value as *const T as *mut std::ffi::c_void) {
            unsafe { encoder.setFragmentBytes_length_atIndex(pointer, size_of::<T>(), index) };
        }
    }

    fn slice<T>(encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>, values: &[T], index: usize) {
        if let Some(pointer) = NonNull::new(values.as_ptr() as *mut std::ffi::c_void) {
            unsafe {
                encoder.setFragmentBytes_length_atIndex(
                    pointer,
                    std::mem::size_of_val(values),
                    index,
                )
            };
        }
    }

    fn read(texture: &Texture, width: usize, height: usize) -> Option<Arc<RenderImage>> {
        let mut pixels = vec![0u8; width * height * 4];
        let region = MTLRegion {
            origin: MTLOrigin { x: 0, y: 0, z: 0 },
            size: MTLSize {
                width,
                height,
                depth: 1,
            },
        };
        let pointer = NonNull::new(pixels.as_mut_ptr().cast::<std::ffi::c_void>())?;
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(pointer, width * 4, region, 0)
        };
        for px in pixels.as_chunks_mut::<4>().0 {
            let alpha = u32::from(px[3]);
            if alpha == 0 {
                *px = [0; 4];
                continue;
            }
            for channel in &mut px[..3] {
                *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
        let image = RgbaImage::from_raw(width as u32, height as u32, pixels)?;
        Some(Arc::new(RenderImage::new([Frame::new(image)])))
    }

    fn render_page(
        renderer: &Renderer,
        request: &PowerUpRequest,
        colors: &[[f32; 4]],
        time: f32,
    ) -> Option<Arc<RenderImage>> {
        let width = ((request.page[0] * PAGE_SCALE).ceil() as usize).max(1);
        let height = ((request.page[1] * PAGE_SCALE).ceil() as usize).max(1);
        let drawn = renderer.texture(width, height)?;
        let across = renderer.texture(width, height)?;
        let done = renderer.texture(width, height)?;
        let count = colors.len() as i32;
        let direction = 0i32;
        renderer.pass(&drawn, &renderer.page, |e| {
            bytes(e, &direction, 0);
            bytes(e, &count, 1);
            slice(e, colors, 2);
            bytes(e, &time, 3);
            bytes(e, &request.speed, 4);
            bytes(e, &PAGE_DELAY, 5);
            bytes(e, &PAGE_FADE_START, 6);
            bytes(e, &PAGE_FADE_DURATION, 7);
            bytes(e, &request.origin, 8);
        })?;
        let sigma = PAGE_BLUR_POINTS * PAGE_SCALE;
        for (source, target, step) in [
            (&drawn, &across, [1.0 / width as f32, 0.0]),
            (&across, &done, [0.0, 1.0 / height as f32]),
        ] {
            renderer.pass(target, &renderer.blur, |e| {
                unsafe { e.setFragmentTexture_atIndex(Some(source), 0) };
                bytes(e, &step, 0);
                bytes(e, &sigma, 1);
            })?;
        }
        read(&done, width, height)
    }

    fn render_halo(
        renderer: &Renderer,
        request: &PowerUpRequest,
        colors: &[[f32; 4]; 2],
        time: f32,
    ) -> Option<Arc<RenderImage>> {
        let frame = request.halo_frame();
        let width = ((frame.w * HALO_SCALE).ceil() as usize).max(1);
        let height = ((frame.h * HALO_SCALE).ceil() as usize).max(1);
        let target = renderer.texture(width, height)?;
        let resolution = [frame.w, frame.h];
        let direction = 0i32;
        let dark = u8::from(request.dark);
        renderer.pass(&target, &renderer.halo, |e| {
            bytes(e, &resolution, 0);
            bytes(e, &direction, 1);
            slice(e, colors, 2);
            bytes(e, &dark, 3);
            bytes(e, &time, 4);
            bytes(e, &request.speed, 5);
            bytes(e, &HALO_DELAY, 6);
            bytes(e, &HALO_FADE_START, 7);
            bytes(e, &HALO_FADE_DURATION, 8);
            bytes(e, &HALO_INSET, 9);
            bytes(e, &request.corner_radius, 10);
        })?;
        read(&target, width, height)
    }

    pub fn play(request: &PowerUpRequest, latest: &Arc<Mutex<PowerUpFrame>>) {
        let Some(renderer) = Renderer::new() else {
            latest.lock().done = true;
            return;
        };
        let colors: Vec<[f32; 4]> = request.palette.iter().copied().map(oklab).collect();
        let halo_colors = halo_colors(&request.palette);
        let started = Instant::now();
        loop {
            let time = started.elapsed().as_secs_f32();
            let page_live = time < PAGE_SECONDS;
            let halo_live = time <= HALO_SECONDS;
            if !page_live && !halo_live {
                *latest.lock() = PowerUpFrame {
                    page: None,
                    halo: None,
                    done: true,
                };
                return;
            }
            let page = page_live
                .then(|| render_page(&renderer, request, &colors, time))
                .flatten();
            let halo = halo_live
                .then(|| render_halo(&renderer, request, &halo_colors, time))
                .flatten();
            *latest.lock() = PowerUpFrame {
                page,
                halo,
                done: false,
            };
            let next = Duration::from_secs_f32(FRAME_SECONDS);
            let spent = started
                .elapsed()
                .saturating_sub(Duration::from_secs_f32(time));
            std::thread::sleep(next.saturating_sub(spent));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oklab_matches_the_old_conversion_for_white_and_black() {
        let white = oklab([1.0, 1.0, 1.0, 1.0]);
        assert!((white[0] - 1.0).abs() < 1e-3 && white[1].abs() < 1e-3 && white[2].abs() < 1e-3);
        let black = oklab([0.0, 0.0, 0.0, 0.5]);
        assert!(black[0].abs() < 1e-6);
        assert_eq!(black[3], 0.5);
    }

    #[test]
    fn the_halo_uses_the_first_two_palette_colours() {
        let one = [[0.2, 0.3, 0.4, 1.0]];
        assert_eq!(halo_colors(&one), [one[0], one[0]]);
    }
}
