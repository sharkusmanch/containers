import { render } from 'preact'
import './ui/styles.css'
const root = document.getElementById('app')!
root.innerHTML =
  '<main class="loading"><h1>Red Mastery Desk</h1><p>Opening the complete field guide…</p></main>'
// Loading the guide separately gives the browser stable, independently cached data chunks.
Promise.all([
  import('./ui/App'),
  import('./data/manifest'),
  import('./ui/controller'),
])
  .then(([{ App }, { dataset }, { createController }]) => {
    root.replaceChildren()
    render(<App dataset={dataset} controller={createController()} />, root)
  })
  .catch(() => {
    root.innerHTML =
      '<main class="loading"><h1>The guide could not load.</h1><p>Check the connection to this private host, then reload. Your saved project remains in this browser.</p><button onclick="location.reload()">Reload guide</button></main>'
  })
