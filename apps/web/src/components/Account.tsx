/**
 * Segue accounts in the app: sign in or create an account, set up and edit
 * the profile, privacy and notifications, sync status, sign out and delete.
 */
import { useState, type FormEvent } from 'react';
import type { MyProfile, PublicProfile } from '@segue/schemas';
import { AuthFailure, passwordProblem, sendPasswordReset, signIn, signUp, updatePassword } from '../lib/auth';
import { ApiError, createProfile, deleteAccount, updateProfile } from '../lib/social';
import type { SyncChoice, SyncPrompt, SyncStatus } from '../lib/useSync';
import { clock } from '../lib/format';
import { Sheet } from './Sheet';

export function Avatar({ person, size = 40 }: { person: Pick<PublicProfile, 'displayName' | 'avatar'> | null | undefined; size?: number }) {
  const initial = (person?.displayName ?? '?').trim().charAt(0).toUpperCase() || '?';
  return person?.avatar ? (
    <img className="avatar" src={person.avatar} alt="" width={size} height={size} style={{ width: size, height: size }} />
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
          <label className="field">
            <span>{mode === 'newPassword' ? 'New password' : 'Password'}</span>
            <span className="password-row">
              <input
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
          </label>
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

/** "Dia Aviles" → "dia_aviles" */
export const suggestUsername = (from: string) =>
  from
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24)
    .padEnd(3, '0');

/** A photo resized on the phone to a small square, so only that is ever uploaded. */
async function squarePhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error('bad image'));
      img.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 160, 160);
    for (const q of [0.82, 0.7, 0.55, 0.4]) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length < 58_000) return data;
    }
    throw new Error('too big');
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  onSaved: (p: MyProfile) => void;
  onClose: () => void;
  onDeleted?: (signInRemoved: boolean) => void;
}) {
  const setup = !profile;
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [username, setUsername] = useState(profile?.username ?? (email ? suggestUsername(email.split('@')[0]!) : ''));
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [avatar, setAvatar] = useState<string | null>(profile?.avatar ?? null);
  const [discoverable, setDiscoverable] = useState(profile?.discoverable ?? false);
  const [notify, setNotify] = useState(profile?.notify ?? { hearts: true, invitations: true, shares: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    try {
      setAvatar(await squarePhoto(file));
    } catch {
      setError("Couldn't use that photo. Try another one.");
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = username.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,24}$/.test(name)) {
      setError('Usernames are 3 to 24 letters, numbers or underscores.');
      return;
    }
    setBusy(true);
    try {
      const input = { username: name, displayName: displayName.trim(), bio: bio.trim(), avatar, discoverable, notify, timezone: zone() };
      const res = setup ? await createProfile(input) : await updateProfile(input);
      if (res.profile) onSaved(res.profile);
    } catch (err) {
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

  return (
    <Sheet title={setup ? 'Set up your profile' : 'Your profile'} onClose={onClose}>
      <form className="form" onSubmit={(e) => void save(e)}>
        {setup && <p className="muted small">This is how people see you when you share notes or invite them. You can change it any time.</p>}
        <div className="avatar-row">
          <Avatar person={{ displayName: displayName || username, avatar }} size={64} />
          <label className="ghost file-button">
            {avatar ? 'Change photo' : 'Add a photo'}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="visually-hidden" onChange={(e) => void pickPhoto(e.target.files?.[0])} />
          </label>
          {avatar && (
            <button type="button" className="text-button" onClick={() => setAvatar(null)}>
              Remove
            </button>
          )}
        </div>
        <label className="field">
          <span>Name</span>
          <input required maxLength={60} autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          <span>Username</span>
          <input
            required
            maxLength={25}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <span className="muted small">Letters, numbers and underscores. People can find you by it if you let them.</span>
        </label>
        <label className="field">
          <span>About you (optional)</span>
          <textarea rows={2} maxLength={280} value={bio} onChange={(e) => setBio(e.target.value)} />
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
        </fieldset>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
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
