import { loadState, normalizeState, saveState } from "./modules/storage.js";
import { renderApp } from "./ui/render.js";

const state = normalizeState(loadState());

function commit(nextState = state) {
  const normalizedState = normalizeState(nextState);
  saveState(normalizedState);
  renderApp(normalizedState, commit);
}

renderApp(state, commit);
