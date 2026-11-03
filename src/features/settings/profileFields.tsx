// Settings → Profile and Account: the name, and the profile's PIN.
import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "../../ui/toast";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { errorMessage } from "../play";
import { Button } from "../../ui/ui";
import { Field } from "./settingsParts";
import { inputClass } from "../../ui/select";

export function NameField() {
  const { token, me } = useAuthed();
  const update = useMutation(api.profiles.update);
  const [name, setName] = useState(me.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== me.name;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!dirty) return;
        setSaving(true);
        try {
          await update({ token, name });
          setError(null);
        } catch (err) {
          setError(errorMessage(err, "Couldn't save the name"));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Field label="Name" htmlFor="name" error={error ?? undefined}>
        <div className="flex gap-2">
          <input
            id="name"
            value={name}
            maxLength={24}
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
          {dirty && (
            <Button type="submit" variant="primary" className="h-11" loading={saving}>
              Save
            </Button>
          )}
        </div>
      </Field>
    </form>
  );
}

/**
 * This profile's PIN: four digits asked for when it's picked. Setting one signs this profile out on other devices,
 * which picked it without one.
 */
export function PinForm() {
  const { token, me } = useAuthed();
  const setPin = useMutation(api.profiles.setPin);
  const [pin, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"set" | "remove" | null>(null);

  const save = async (next: string | null) => {
    if (next !== null && !/^\d{4}$/.test(next)) return setError("A PIN is 4 digits");
    setSaving(next === null ? "remove" : "set");
    try {
      await setPin({ token, pin: next });
      setValue("");
      toast(next === null ? "PIN removed" : me.hasPin ? "PIN changed. Other devices were signed out." : "PIN set. Other devices were signed out.");
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the PIN"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(pin);
      }}
    >
      <Field
        label={me.hasPin ? "New PIN" : "PIN"}
        htmlFor="pin"
        hint={me.hasPin ? "This profile is locked with a PIN." : "Lock this profile so it asks for 4 digits when it's picked."}
        error={error}
      >
        <input
          id="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={pin}
          onChange={(e) => {
            setValue(e.target.value.replace(/\D/g, "").slice(0, 4));
            setError(null);
          }}
          placeholder="••••"
          className={`${inputClass} max-w-40 text-center tracking-[0.5em]`}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={saving === "set"}>
          {me.hasPin ? "Change PIN" : "Set PIN"}
        </Button>
        {me.hasPin && (
          <Button type="button" variant="ghost" loading={saving === "remove"} onClick={() => void save(null)}>
            Remove PIN
          </Button>
        )}
      </div>
    </form>
  );
}
