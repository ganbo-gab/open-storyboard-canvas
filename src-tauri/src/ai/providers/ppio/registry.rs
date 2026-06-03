use std::collections::HashSet;

use super::adapter::PPIOModelAdapter;
use super::models::collect_adapters;

pub struct PPIOModelRegistry {
    adapters: Vec<Box<dyn PPIOModelAdapter>>,
}

impl PPIOModelRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            adapters: Vec::new(),
        };

        for adapter in collect_adapters() {
            registry.register(adapter);
        }

        registry
    }

    pub fn register(&mut self, adapter: Box<dyn PPIOModelAdapter>) {
        self.adapters.push(adapter);
    }

    pub fn resolve(&self, model: &str) -> Option<&dyn PPIOModelAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.matches(model))
            .map(|adapter| adapter.as_ref())
    }

    pub fn supports(&self, model: &str) -> bool {
        self.resolve(model).is_some()
    }

    pub fn list_models(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut models = Vec::new();

        for model in self
            .adapters
            .iter()
            .map(|adapter| adapter.canonical_model())
        {
            if seen.insert(model) {
                models.push(model.to_string());
            }
        }

        models.sort();
        models
    }
}

impl Default for PPIOModelRegistry {
    fn default() -> Self {
        Self::new()
    }
}
