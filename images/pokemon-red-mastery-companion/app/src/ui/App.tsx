import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Dataset } from '../model'
import { activeAttempt } from '../state/project'
import { planRun } from '../planner/route'
import { planGlitches } from '../planner/glitches'
import type { Controller } from './controller'
import { AUTOMATIC_INTERVAL } from '../sources/poller'
import { Next } from './Next'
import { Dex } from './Dex'
import { Areas } from './Areas'
import { Achievements } from './Achievements'
import { More } from './More'
const screens = ['Next', 'Dex', 'Areas', 'Achievements', 'More'] as const
type Screen = (typeof screens)[number]
const icons = [
  'M5 12h14m-6-6 6 6-6 6',
  'M6 4h12v16H6zM9 8h6M9 12h6',
  'M12 3v4m0 10v4M3 12h4m10 0h4M8 8h8v8H8z',
  'm12 3 3 6 6 1-4 5 1 6-6-3-6 3 1-6-4-5 6-1z',
  'M5 6h14M5 12h14M5 18h14',
]
export function App({
  controller,
  dataset,
}: {
  controller: Controller
  dataset: Dataset
}) {
  const [, update] = useState(0),
    [screen, setScreen] = useState<Screen>('Next')
  useEffect(
    () => controller.subscribe(() => update((n) => n + 1)),
    [controller],
  )
  const project = controller.getProject(),
    attempt = activeAttempt(project),
    input = useMemo(
      () => ({ project, attempt, dataset }),
      [project, attempt, dataset],
    )
  const plan = useMemo(() => planRun(input), [input]),
    glitches = useMemo(() => planGlitches(input), [input])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden')
        void controller.saves.refresh(true)
    }
    const timer = setInterval(refresh, AUTOMATIC_INTERVAL)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      controller.saves.cancel()
    }
  }, [controller, project.activeAttemptId, attempt.source.revision])
  function navigate(next: Screen) {
    setScreen(next)
    window.scrollTo?.(0, 0)
  }
  const error = controller.getError()
  return (
    <div class="app-shell">
      <a class="skip" href="#main">
        Skip to guide
      </a>
      <aside class="rail">
        <div class="brand">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <rect x="4" y="3" width="34" height="42" rx="8" />
            <path d="M12 14h18M12 22h18M12 30h9" />
            <circle cx="34" cy="35" r="8" />
          </svg>
          <span>
            RED<span>MASTERY DESK</span>
          </span>
        </div>
        <nav aria-label="Main navigation">
          {screens.map((s, i) => (
            <button
              key={s}
              class={screen === s ? 'active' : ''}
              aria-current={screen === s ? 'page' : undefined}
              onClick={() => navigate(s)}
            >
              <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d={icons[i]} />
              </svg>
              {s}
            </button>
          ))}
        </nav>
        <p class="rail-note">
          A careful route.
          <br />
          Your own collection.
        </p>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div>
            <strong>{attempt.name}</strong>
            <span>
              {attempt.kind === 'canonical'
                ? 'Protected main / Oak'
                : attempt.kind + ' attempt'}
            </span>
          </div>
          <div class="freshness">
            <span class={`status-dot ${attempt.snapshot ? 'has-save' : ''}`} />
            <span>
              {project.pendingImport
                ? 'Reading save…'
                : attempt.snapshot
                  ? `Save observed ${new Date(attempt.snapshot.importedAt).toLocaleString()}`
                  : 'No save imported'}
              {attempt.source.lastError
                ? attempt.snapshot
                  ? ' · last good snapshot retained'
                  : ' · source unavailable'
                : ''}
              {attempt.source.paused ? ' · auto paused' : ''}
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {error && (
            <div class="notice recovery" role="alert">
              <p>{error}</p>
              <button class="quiet" onClick={() => controller.clearError()}>
                Dismiss recovery notice
              </button>
            </div>
          )}
          {screen === 'Next' && (
            <Next
              key={attempt.id}
              input={input}
              plan={plan}
              onAreas={() => navigate('Areas')}
            />
          )}
          {screen === 'Dex' && <Dex input={input} />}
          {screen === 'Areas' && (
            <Areas
              key={attempt.id}
              input={input}
              plan={plan}
              controller={controller}
            />
          )}
          {screen === 'Achievements' && (
            <Achievements
              input={input}
              plan={plan}
              glitches={glitches}
              controller={controller}
            />
          )}
          {screen === 'More' && (
            <More
              key={`${attempt.id}/${attempt.source.revision}`}
              input={input}
              plan={plan}
              controller={controller}
            />
          )}
          <footer>
            English Pokémon Red · read-only companion · sourced guidance with
            open runtime validation
          </footer>
        </main>
      </div>
    </div>
  )
}
