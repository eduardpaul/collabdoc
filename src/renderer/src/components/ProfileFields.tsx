import { USER_COLORS } from '@shared/actors'
import { handleFromName, isValidHandle } from '@shared/handles'
import { Field, TextInput } from './ui'

export function ProfileFields({
  name,
  handle,
  color,
  onChange
}: {
  name: string
  handle: string
  color: string
  onChange: (patch: { name?: string; handle?: string; color?: string }) => void
}): React.JSX.Element {
  const handleOk = isValidHandle(handle)
  return (
    <div className="form-grid">
      <Field label="Display name">
        <TextInput
          value={name}
          maxLength={40}
          autoComplete="nickname"
          onChange={(event) => {
            const next = event.target.value
            const derived = handleFromName(name)
            onChange({
              name: next,
              handle: handle === derived || !handleOk ? handleFromName(next) : handle
            })
          }}
        />
      </Field>
      <Field
        label="Handle"
        hint={handleOk ? `@${handle}` : '2–20 lowercase letters, numbers, _ or -'}
      >
        <TextInput
          value={handle}
          spellCheck={false}
          onChange={(event) => onChange({ handle: event.target.value.toLowerCase() })}
        />
      </Field>
      <Field label="Colour">
        <div className="color-row" role="listbox" aria-label="Colour">
          {USER_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              role="option"
              aria-selected={value === color}
              aria-label={value}
              className={`color-swatch ${value === color ? 'is-active' : ''}`}
              style={{ background: value }}
              onClick={() => onChange({ color: value })}
            />
          ))}
        </div>
      </Field>
    </div>
  )
}
