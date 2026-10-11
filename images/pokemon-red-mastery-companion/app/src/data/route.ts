import curated from './route.curated.json'
import type { RouteStep } from '../model'
// Exact Oak phase groups independently checked by test/oak.test.ts; docs/oak-validation.md records scope.
export const route: RouteStep[] = curated as RouteStep[]
