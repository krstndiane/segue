import { useCallback, useEffect, useRef, useState } from 'react';
import { usernameAvailability } from './social';
import { EMPTY_STATE, UsernameChecker, type UsernameState } from './usernameCheck';

/** Live availability for the username in a form. `current` is the person's own saved username, if any. */
export function useUsernameCheck(raw: string, current?: string) {
  const [state, setState] = useState<UsernameState>(EMPTY_STATE);
  const checker = useRef<UsernameChecker | null>(null);
  if (!checker.current) checker.current = new UsernameChecker({ ask: usernameAvailability, onState: setState });

  useEffect(() => {
    checker.current?.update(raw, current);
  }, [raw, current]);
  useEffect(() => () => checker.current?.dispose(), []);

  const retry = useCallback(() => checker.current?.retry(), []);
  const markTaken = useCallback((name: string) => checker.current?.markTaken(name), []);
  return { state, retry, markTaken };
}
