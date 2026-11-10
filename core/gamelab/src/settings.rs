//! Descriptions of a game's rule settings.
//!
//! A game's rules are a plain struct that serialises to JSON. The list of
//! `Setting`s tells the lab how to present each field of that object for
//! editing; the defaults come from the rules' `Default`.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    /// Field name in the rules JSON object.
    pub key: &'static str,
    pub label: &'static str,
    pub help: &'static str,
    /// Heading the setting is listed under.
    pub group: &'static str,
    #[serde(flatten)]
    pub kind: SettingKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SettingKind {
    Bool,
    Int { min: i32, max: i32 },
    /// One of a fixed list of values.
    Choice { options: Vec<Choice> },
    /// One whole number per rank, ace to king (a 13-element array).
    RankInts { min: i32, max: i32 },
    /// One choice per rank, ace to king (a 13-element array).
    RankChoices { options: Vec<Choice> },
}

#[derive(Clone, Debug, Serialize)]
pub struct Choice {
    pub value: Value,
    pub label: &'static str,
}

impl Setting {
    pub fn bool(group: &'static str, key: &'static str, label: &'static str, help: &'static str) -> Setting {
        Setting { key, label, help, group, kind: SettingKind::Bool }
    }
    pub fn int(
        group: &'static str,
        key: &'static str,
        label: &'static str,
        help: &'static str,
        min: i32,
        max: i32,
    ) -> Setting {
        Setting { key, label, help, group, kind: SettingKind::Int { min, max } }
    }
    pub fn rank_ints(
        group: &'static str,
        key: &'static str,
        label: &'static str,
        help: &'static str,
        min: i32,
        max: i32,
    ) -> Setting {
        Setting { key, label, help, group, kind: SettingKind::RankInts { min, max } }
    }

    /// Whether `value` is acceptable for this setting.
    pub fn accepts(&self, value: &Value) -> bool {
        let int_in = |v: &Value, min: i32, max: i32| {
            v.as_i64().is_some_and(|x| (min as i64..=max as i64).contains(&x))
        };
        let per_rank = |ok: &dyn Fn(&Value) -> bool| value.as_array().is_some_and(|a| a.len() == 13 && a.iter().all(ok));
        match &self.kind {
            SettingKind::Bool => value.is_boolean(),
            SettingKind::Int { min, max } => int_in(value, *min, *max),
            SettingKind::Choice { options } => options.iter().any(|o| &o.value == value),
            SettingKind::RankInts { min, max } => per_rank(&|v| int_in(v, *min, *max)),
            SettingKind::RankChoices { options } => per_rank(&|v| options.iter().any(|o| &o.value == v)),
        }
    }
}

/// Check a rules object against the settings: every listed field must be
/// present and in range, and no unknown field may appear.
pub fn check_rules(settings: &[Setting], rules: &Value) -> Result<(), String> {
    let Some(obj) = rules.as_object() else {
        return Err("rules must be an object".into());
    };
    for s in settings {
        match obj.get(s.key) {
            None => return Err(format!("missing setting {}", s.key)),
            Some(v) if !s.accepts(v) => return Err(format!("{} is out of range", s.key)),
            _ => {}
        }
    }
    if let Some(extra) = obj.keys().find(|k| !settings.iter().any(|s| s.key == k.as_str())) {
        return Err(format!("unknown setting {extra}"));
    }
    Ok(())
}

/// A random rules object: each setting keeps its default with probability
/// one half and otherwise takes a uniformly random allowed value. Used to
/// exercise games across their whole rule space.
pub fn random_rules(settings: &[Setting], defaults: &Value, rng: &mut crate::rng::Rng) -> Value {
    let mut rules = defaults.clone();
    let int = |rng: &mut crate::rng::Rng, min: i32, max: i32| Value::from(min + rng.int((max - min + 1) as usize) as i32);
    for s in settings {
        if rng.int(2) == 0 {
            continue;
        }
        rules[s.key] = match &s.kind {
            SettingKind::Bool => Value::from(rng.int(2) == 1),
            SettingKind::Int { min, max } => int(rng, *min, *max),
            SettingKind::Choice { options } => options[rng.int(options.len())].value.clone(),
            SettingKind::RankInts { min, max } => (0..13).map(|_| int(rng, *min, *max)).collect(),
            SettingKind::RankChoices { options } => {
                (0..13).map(|_| options[rng.int(options.len())].value.clone()).collect()
            }
        };
    }
    rules
}
