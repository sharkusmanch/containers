import { render } from 'preact'
import './ui/styles.css'
import { loadDeploymentConfig } from './sources/deployment'
const root = document.getElementById('app')!
root.innerHTML =
  '<main class="loading"><h1>Red Mastery Desk</h1><p>Opening the guide…</p></main>'
// Loading the guide separately gives the browser stable, independently cached data chunks.
Promise.all([
  import('./ui/App'),
  import('./data/manifest'),
  import('./ui/controller'),
  // Absent on the public build (404 → manual upload mode); bounded to five seconds.
  loadDeploymentConfig(),
])
  .then(([{ App }, { dataset }, { createController }, deployment]) => {
    root.replaceChildren()
    render(
      <App dataset={dataset} controller={createController({ deployment })} />,
      root,
    )
  })
  .catch(() => {
    root.innerHTML =
      '<main class="loading"><h1>The guide could not load.</h1><p>Check the connection to this private host, then reload. Your saved project remains in this browser.</p><button onclick="location.reload()">Reload guide</button></main>'
  })
