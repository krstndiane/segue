/**
 * Segue accounts in the app: sign in or create an account, set up and edit
 * the profile, privacy and notifications, sync status, sign out and delete.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { MyProfile, PublicProfile } from '@segue/schemas';
import { AuthFailure, passwordProblem, sendPasswordReset, signIn, signUp, updatePassword } from '../lib/auth';
import { ApiError, createProfile, deleteAccount, removeAvatar, updateProfile, uploadAvatar } from '../lib/social';
import type { SyncChoice, SyncPrompt, SyncStatus } from '../lib/useSync';
import { clock } from '../lib/format';
import { AvatarCropper, photoProblem } from './AvatarCropper';
import { useUsernameCheck } from '../lib/useUsernameCheck';
import { Sheet } from './Sheet';

export function Avatar({ person, size = 40 }: { person: Pick<PublicProfile, 'displayName' | 'avatar'> | null | undefined; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [person?.avatar]);
  const initial = (person?.displayName ?? '?').trim().charAt(0).toUpperCase() || '?';
  return person?.avatar && !broken ? (
    <img className="avatar" src={person.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} />
  ) : (
    <span className="avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initial}
    </span>
  );
}

type AuthMode = 'signin' | 'signup' | 'forgot' | 'newPassword' | 'checkEmail' | 'resetSent';

/** Sign in, create an account, or reset a password. */
export function AuthSheet({ start = 'signin', onClose, onDone }: { start?: AuthMode; onClose: () => void; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<AuthMode>(start);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if ((mode === 'signup' || mode === 'newPassword') && passwordProblem(password)) {
      setError(passwordProblem(password));
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        onDone('Signed in.');
      } else if (mode === 'signup') {
        const { confirmEmail } = await signUp(email, password);
        if (confirmEmail) setMode('checkEmail');
        else onDone('Account created.');
      } else if (mode === 'forgot') {
        await sendPasswordReset(email);
        setMode('resetSent');
      } else if (mode === 'newPassword') {
        await updatePassword(password);
        onDone('Password changed.');
      }
    } catch (err) {
      setError(err instanceof AuthFailure ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<AuthMode, string> = {
    signin: 'Sign in to Segue',
    signup: 'Create your Segue account',
    forgot: 'Reset your password',
    newPassword: 'Set a new password',
    checkEmail: 'Check your email',
    resetSent: 'Check your email',
  };

  if (mode === 'checkEmail' || mode === 'resetSent') {
    return (
      <Sheet title={titles[mode]} onClose={onClose}>
        <div className="form">
          <p>
            {mode === 'checkEmail'
              ? `We sent a link to ${email}. Open it on this device to finish creating your account.`
              : `If ${email} has a Segue account, a link to set a new password is on its way.`}
          </p>
          <p className="muted small">Nothing there? Check spam, or wait a minute and try again.</p>
          <button type="button" className="primary wide" onClick={onClose}>
            Done
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={titles[mode]} onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        {mode === 'signup' && <p className="muted small">An account keeps your plans on every device and lets you share notes and invite people. Your planner works without one too.</p>}
        {mode !== 'newPassword' && (
          <label className="field">
            <span>Email</span>
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        {mode !== 'forgot' && (
          <div className="field">
            <label htmlFor="auth-password">{mode === 'newPassword' ? 'New password' : 'Password'}</label>
            <span className="password-row">
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={mode === 'signin' ? 1 : 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="text-button" aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
            {(mode === 'signup' || mode === 'newPassword') && <span className="muted small">At least 8 characters, with a number.</span>}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Save password'}
        </button>
        {mode === 'signin' && (
          <div className="row-actions center">
            <button type="button" className="text-button" onClick={() => setMode('signup')}>
              Create an account
            </button>
            <button type="button" className="text-button" onClick={() => setMode('forgot')}>
              Forgot password?
            </button>
          </div>
        )}
        {(mode === 'signup' || mode === 'forgot') && (
          <button type="button" className="text-button" onClick={() => setMode('signin')}>
            I already have an account
          </button>
        )}
      </form>
    </Sheet>
  );
}

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** "Dia Aviles" → "dia_aviles": a starting point that follows the username rules, or '' if nothing usable is left. */
export const suggestUsername = (from: string) => {
  const name = from
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 20)
    .replace(/_+$/, '');
  return name.length >= 3 ? name : '';
};

/** First-time setup or editing: name, username, photo, privacy and notifications. */
export function ProfileSheet({
  profile,
  email,
  onSaved,
  onClose,
  onDeleted,
}: {
  /** null = first-time setup */
  profile: MyProfile | null;
  email?: string;
  /** `photoProblem` is set when the details saved but the photo didn't */
  onSaved: (p: MyProfile, photoProblem?: string) => void;
  onClose: () => void;
  onDeleted?: (signInRemoved: boolean) => void;
}) {
  const setup = !profile;
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [username, setUsername] = useState(profile?.username ?? (email ? suggestUsername(email.split('@')[0]!) : ''));
  const check = useUsernameCheck(username, profile?.username);
  const nameBlocked = ['empty', 'hint', 'invalid', 'taken', 'reserved'].includes(check.state.status);
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [pronouns, setPronouns] = useState(profile?.pronouns ?? '');
  const [interests, setInterests] = useState((profile?.interests ?? []).join(', '));
  /** the photo as it will be after saving: unchanged, a new cropped one, or none */
  const [photo, setPhoto] = useState<{ kind: 'same' } | { kind: 'new'; blob: Blob } | { kind: 'none' }>({ kind: 'same' });
  const [cropFile, setCropFile] = useState<File | null>(null);
  const preview = useMemo(() => (photo.kind === 'new' ? URL.createObjectURL(photo.blob) : null), [photo]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const avatar = photo.kind === 'new' ? preview : photo.kind === 'none' ? null : (profile?.avatar ?? null);
  const [discoverable, setDiscoverable] = useState(profile?.discoverable ?? false);
  const [visibility, setVisibility] = useState(profile?.profileVisibility ?? 'everyone');
  const [showMutualCount, setShowMutualCount] = useState(profile?.showMutualCount ?? false);
  const [whoCanInvite, setWhoCanInvite] = useState(profile?.whoCanInvite ?? 'everyone');
  const [notify, setNotify] = useState(profile?.notify ?? { hearts: true, invitations: true, shares: true, connections: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    const problem = photoProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setCropFile(file);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (nameBlocked) {
      setError(check.state.message);
      return;
    }
    const name = username.trim();
    setBusy(true);
    try {
      const input = {
        username: name,
        displayName: displayName.trim(),
        bio: bio.trim(),
        pronouns: pronouns.trim(),
        interests: interests.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10),
        discoverable,
        profileVisibility: visibility,
        showMutualCount,
        whoCanInvite,
        notify,
        timezone: zone(),
      };
      let res = setup ? await createProfile(input) : await updateProfile(input);
      // The details are saved first; the photo goes up second, so a photo problem never loses them.
      try {
        if (photo.kind === 'new') res = await uploadAvatar(photo.blob);
        else if (photo.kind === 'none' && profile?.avatar) res = await removeAvatar();
      } catch (err) {
        if (res.profile) onSaved(res.profile, err instanceof ApiError ? err.message : "Couldn't upload your photo.");
        return;
      }
      if (res.profile) onSaved(res.profile);
    } catch (err) {
      // Everything else they typed stays in the form; only the username needs another try.
      if (err instanceof ApiError && err.code === 'username_taken') check.markTaken(name);
      setError(err instanceof ApiError ? err.message : "Couldn't save just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteAccount();
      onDeleted?.(res.signInRemoved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete just now. Try again.");
      setBusy(false);
    }
  }

  if (cropFile) {
    return (
      <AvatarCropper
        file={cropFile}
        onCancel={() => setCropFile(null)}
        onDone={(blob) => {
          setPhoto({ kind: 'new', blob });
          setCropFile(null);
        }}
      />
    );
  }

  return (
    <Sheet title={setup ? 'Set up your profile' : 'Your profile'} onClose={onClose}>
      <form className="form" onSubmit={(e) => void save(e)}>
        {setup && <p className="muted small">This is how people see you when you share notes or invite them. You can change it any time.</p>}
        <div className="avatar-row">
          <Avatar person={{ displayName: displayName || username, avatar }} size={72} />
          <label className="ghost file-button">
            {avatar ? 'Change photo' : 'Add a photo'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="visually-hidden"
              onChange={(e) => {
                pickPhoto(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {avatar && (
            <button type="button" className="text-button" onClick={() => setPhoto({ kind: 'none' })}>
              Remove
            </button>
          )}
        </div>
        <label className="field">
          <span>Name</span>
          <input required maxLength={60} autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <div className="field">
          <label htmlFor="profile-username">Username</label>
          <span className="username-row">
            <span className="username-at" aria-hidden="true">
              @
            </span>
            <input
              id="profile-username"
              required
              maxLength={24}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              spellCheck={false}
              value={username}
              aria-invalid={['invalid', 'taken', 'reserved'].includes(check.state.status)}
              aria-describedby="username-status username-help"
              onChange={(e) => setUsername(e.target.value)}
            />
          </span>
          <p id="username-status" className={`username-status ${check.state.status}`} role="status" aria-live="polite">
            <span aria-hidden="true">
              {check.state.status === 'available' || check.state.status === 'yours' ? '✓ ' : check.state.status === 'taken' || check.state.status === 'invalid' || check.state.status === 'reserved' || check.state.status === 'error' ? '⚠ ' : check.state.status === 'checking' ? '… ' : ''}
            </span>
            {check.state.message}
            {check.state.status === 'error' && (
              <>
                {' '}
                <button type="button" className="text-button" onClick={check.retry}>
                  Try again
                </button>
              </>
            )}
          </p>
          {check.state.suggestions.length > 0 && (
            <p className="small">
              Try:{' '}
              {check.state.suggestions.map((s) => (
                <button key={s} type="button" className="chip username-suggestion" onClick={() => setUsername(s)}>
                  {s}
                </button>
              ))}
            </p>
          )}
          <span id="username-help" className="muted small">
            3 to 20 letters, numbers or underscores. Starts with a letter. Capitals are the same as lowercase, so Dia and dia are one name.
          </span>
          {profile?.usernameNeedsChange && check.state.status === 'yours' && (
            <span className="small" role="note">
              Your username is from before Segue's current rules. It still works, but you're welcome to choose a new one.
            </span>
          )}
        </div>
        <label className="field">
          <span>About you (optional)</span>
          <textarea rows={2} maxLength={280} value={bio} onChange={(e) => setBio(e.target.value)} />
        </label>
        <label className="field">
          <span>Pronouns (optional)</span>
          <input maxLength={40} value={pronouns} onChange={(e) => setPronouns(e.target.value)} />
        </label>
        <label className="field">
          <span>Interests (optional)</span>
          <input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder="climbing, coffee, markets" />
          <span className="muted small">Up to 10, separated by commas.</span>
        </label>

        <fieldset className="field">
          <legend>Who can find you</legend>
          <label className="check">
            <input type="radio" name="find" checked={!discoverable} onChange={() => setDiscoverable(false)} />
            <span>
              <strong>Only people I share with</strong>
              <span className="muted small block">Private. Nobody can search for you.</span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="find" checked={discoverable} onChange={() => setDiscoverable(true)} />
            <span>
              <strong>People can find me by name or username</strong>
              <span className="muted small block">They see your name, photo and notes you make discoverable. Never your email, plans or location.</span>
            </span>
          </label>
        </fieldset>

        <fieldset className="field">
          <legend>Who sees your profile details</legend>
          {(
            [
              ['everyone', 'Everyone who finds you', 'Your about text, pronouns and interests.'],
              ['mutuals', 'Only my mutuals', 'Everyone else sees just your name and photo.'],
              ['only_me', 'Only me', 'Everyone else sees just your name and photo.'],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="check">
              <input type="radio" name="visibility" checked={visibility === value} onChange={() => setVisibility(value)} />
              <span>
                <strong>{label}</strong>
                <span className="muted small block">{hint}</span>
              </span>
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={showMutualCount} onChange={(e) => setShowMutualCount(e.target.checked)} />
            <span>Show how many mutuals I have</span>
          </label>
        </fieldset>

        <fieldset className="field">
          <legend>Who can invite you</legend>
          {(
            [
              ['everyone', 'Anyone who can find me'],
              ['mutuals', 'Only my mutuals'],
              ['nobody', 'Nobody'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="check">
              <input type="radio" name="invite" checked={whoCanInvite === value} onChange={() => setWhoCanInvite(value)} />
              <span>{label}</span>
            </label>
          ))}
          <span className="muted small">If someone hearts your note and you say “invite me”, you can still be invited to that one.</span>
        </fieldset>

        <fieldset className="field">
          <legend>Tell me when</legend>
          <label className="check">
            <input type="checkbox" checked={notify.hearts} onChange={(e) => setNotify({ ...notify, hearts: e.target.checked })} />
            <span>Someone hearts my note</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={notify.invitations} onChange={(e) => setNotify({ ...notify, invitations: e.target.checked })} />
            <span>I get an invitation, or someone answers mine</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={notify.shares} onChange={(e) => setNotify({ ...notify, shares: e.target.checked })} />
            <span>Someone shares a note with me</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={notify.connections} onChange={(e) => setNotify({ ...notify, connections: e.target.checked })} />
            <span>Someone asks to connect, or accepts my request</span>
          </label>
        </fieldset>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy || nameBlocked}>
          {busy ? 'Saving…' : setup ? 'Save and continue' : 'Save'}
        </button>

        {!setup && (
          <section className="settings-group danger-zone">
            <h3 className="section-title">Delete account</h3>
            {!deleting ? (
              <button type="button" className="danger" onClick={() => setDeleting(true)}>
                Delete my account…
              </button>
            ) : (
              <>
                <p className="small">
                  This deletes your profile, notes, hearts, invitations and the plans saved to your account. It can't be undone. The plans on this
                  device stay here.
                </p>
                <label className="field">
                  <span>Type DELETE to confirm</span>
                  <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoCapitalize="characters" />
                </label>
                <div className="row-actions">
                  <button type="button" className="danger" disabled={confirmText !== 'DELETE' || busy} onClick={() => void remove()}>
                    Delete everything
                  </button>
                  <button type="button" className="ghost" onClick={() => setDeleting(false)}>
                    Keep my account
                  </button>
                </div>
              </>
            )}
          </section>
        )}
      </form>
    </Sheet>
  );
}

const SYNC_WORDS: Record<SyncStatus, string> = {
  off: 'Not syncing.',
  paused: 'Sync is paused on this device.',
  syncing: 'Syncing…',
  synced: 'Your plans are synced.',
  offline: "You're offline. Changes will sync when you're back.",
  error: "Couldn't sync just now. Segue will try again.",
};

/** The account part of Settings. */
export function AccountSettings(props: {
  state: string;
  profile: MyProfile | null;
  email?: string;
  sync: { status: SyncStatus; lastSynced: string | null };
  onSignIn: () => void;
  onCreate: () => void;
  onProfile: () => void;
  onChangePassword: () => void;
  onSignOut: () => void;
  onResumeSync: () => void;
  onRetry: () => void;
}) {
  const { profile } = props;
  return (
    <section className="settings-group">
      <h3 className="section-title">Segue account</h3>
      {props.state === 'signed-out' && (
        <>
          <p className="muted small">Keep your plans on every device, share notes and invite people. Optional: Segue works without one.</p>
          <div className="row-actions">
            <button type="button" className="primary" onClick={props.onCreate}>
              Create account
            </button>
            <button type="button" className="ghost" onClick={props.onSignIn}>
              Sign in
            </button>
          </div>
        </>
      )}
      {(props.state === 'loading' || props.state === 'offline') && (
        <>
          <p className="muted small">{props.state === 'loading' ? 'Loading your account…' : "Couldn't reach your account right now."}</p>
          <div className="row-actions">
            {props.state === 'offline' && (
              <button type="button" className="ghost" onClick={props.onRetry}>
                Try again
              </button>
            )}
            <button type="button" className="ghost" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </>
      )}
      {props.state === 'needs-profile' && (
        <>
          <p className="muted small">Signed in as {props.email}. One more step: set up your profile.</p>
          <div className="row-actions">
            <button type="button" className="primary" onClick={props.onProfile}>
              Set up profile
            </button>
            <button type="button" className="ghost" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </>
      )}
      {props.state === 'ready' && profile && (
        <>
          <div className="account-row">
            <Avatar person={profile} size={44} />
            <span>
              <strong>{profile.displayName}</strong>
              <span className="muted small block">
                @{profile.username} · {props.email}
              </span>
            </span>
          </div>
          <p className="muted small" role="status">
            {SYNC_WORDS[props.sync.status]}
            {props.sync.status === 'synced' && props.sync.lastSynced ? ` Last checked ${clock(props.sync.lastSynced)}.` : ''}{' '}
            {profile.discoverable ? 'People can find you.' : 'Only people you share with can see you.'}
          </p>
          <div className="row-actions">
            <button type="button" className="ghost" onClick={props.onProfile}>
              Profile and privacy
            </button>
            {props.sync.status === 'paused' && (
              <button type="button" className="ghost" onClick={props.onResumeSync}>
                Sync this device
              </button>
            )}
            <button type="button" className="ghost" onClick={props.onChangePassword}>
              Change password
            </button>
            <button type="button" className="ghost" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
          <p className="muted small">Signing out keeps a copy of your plans on this device. To clear them too, use Start over below.</p>
        </>
      )}
    </section>
  );
}

/** First time this account meets a device that already has plans. */
export function SyncPromptSheet({ prompt, onChoose }: { prompt: Exclude<SyncPrompt, null>; onChoose: (c: SyncChoice) => void }) {
  return (
    <Sheet title={prompt === 'import' ? 'Bring your plans along?' : 'This device has plans too'} onClose={() => onChoose('later')}>
      <div className="form">
        {prompt === 'import' ? (
          <>
            <p>Your account is new. Save the routines, settings, saved places and past days on this device to your account, so they show up when you sign in elsewhere?</p>
            <button type="button" className="primary wide" onClick={() => onChoose('import')}>
              Save them to my account
            </button>
          </>
        ) : (
          <>
            <p>Your account already has plans, and so does this device. How should they come together?</p>
            <button type="button" className="primary wide" onClick={() => onChoose('combine')}>
              Combine them
            </button>
            <p className="muted small">Keeps everything from both. Where both have the same routine, this device's version wins.</p>
            <button type="button" className="ghost wide" onClick={() => onChoose('useAccount')}>
              Use my account's plans here
            </button>
            <p className="muted small">Replaces what's on this device with your account's copy.</p>
          </>
        )}
        <button type="button" className="text-button" onClick={() => onChoose('later')}>
          Not now: keep this device separate
        </button>
        <p className="muted small">Google Calendar events and your exact location are never saved to your account.</p>
      </div>
    </Sheet>
  );
}
