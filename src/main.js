import { loadState, saveState } from "./modules/storage.js";
import { renderApp } from "./ui/render.js";

const state = loadState();

function commit(nextState = state) {
  saveState(nextState);
  renderApp(nextState, commit);
}

renderApp(state, commit);
