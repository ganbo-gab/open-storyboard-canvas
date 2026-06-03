use std::sync::Arc;

use super::AIProvider;

pub mod fal;
pub mod grsai;
pub mod kie;
pub mod ppio;

pub use fal::FalProvider;
pub use grsai::GrsaiProvider;
pub use kie::KieProvider;
pub use ppio::PPIOProvider;

pub fn build_default_providers() -> Vec<Arc<dyn AIProvider>> {
    vec![
        Arc::new(PPIOProvider::new()),
        Arc::new(GrsaiProvider::new()),
        Arc::new(KieProvider::new()),
        Arc::new(FalProvider::new()),
    ]
}
