import { rankLabel, type LabSetting, type Rules } from './format.js';

interface Props {
  settings: LabSetting[];
  rules: Rules;
  /** The rules this set is compared with; settings that differ are marked. */
  base: Rules;
  onChange: (key: string, value: unknown) => void;
}

function clamp(setting: LabSetting, text: string, before: unknown): unknown {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return before;
  return Math.min(setting.max ?? n, Math.max(setting.min ?? n, n));
}

function Field({ setting, value, onChange }: { setting: LabSetting; value: unknown; onChange: (value: unknown) => void }) {
  const options = setting.options ?? [];
  const pick = (current: unknown, set: (value: unknown) => void, label: string) => (
    <select
      aria-label={label}
      value={options.findIndex((o) => o.value === current)}
      onChange={(e) => set(options[Number(e.target.value)]!.value)}
    >
      {options.map((o, i) => <option key={String(o.value)} value={i}>{o.label}</option>)}
    </select>
  );
  const replace = (list: unknown[], i: number, v: unknown): unknown[] => list.map((old, j) => (j === i ? v : old));
  switch (setting.kind) {
    case 'bool':
      return <input type="checkbox" aria-label={setting.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'choice':
      return pick(value, onChange, setting.label);
    case 'rankInts':
    case 'rankChoices': {
      const list = Array.isArray(value) ? value : [];
      return (
        <span className="lab-ranks">
          {list.map((v, i) => (
            <label key={i}>
              <span>{rankLabel(i)}</span>
              {setting.kind === 'rankInts' ? (
                <input
                  type="number"
                  min={setting.min}
                  max={setting.max}
                  value={Number(v)}
                  onChange={(e) => onChange(replace(list, i, clamp(setting, e.target.value, v)))}
                />
              ) : pick(v, (next) => onChange(replace(list, i, next)), `${setting.label}: ${rankLabel(i)}`)}
            </label>
          ))}
        </span>
      );
    }
    default:
      return (
        <input
          type="number"
          aria-label={setting.label}
          min={setting.min}
          max={setting.max}
          value={Number(value)}
          onChange={(e) => onChange(clamp(setting, e.target.value, value))}
        />
      );
  }
}

/** Every rule of a game, grouped as the rules core groups them. */
export default function RulesEditor({ settings, rules, base, onChange }: Props) {
  const groups = [...new Set(settings.map((s) => s.group))];
  return (
    <div className="lab-rules">
      {groups.map((group) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          {settings.filter((s) => s.group === group).map((setting) => {
            const changed = JSON.stringify(rules[setting.key]) !== JSON.stringify(base[setting.key]);
            const wide = setting.kind.startsWith('rank');
            return (
              <div key={setting.key} className={`lab-rule${changed ? ' changed' : ''}${wide ? ' wide' : ''}`}>
                <span className="lab-rule-name">
                  {setting.label}
                  <small>{setting.help}</small>
                </span>
                <Field setting={setting} value={rules[setting.key]} onChange={(v) => onChange(setting.key, v)} />
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
