// Replaced by providers/tesla/* (guide 01 §15). This facade only exists so
// stale imports keep compiling; import from ./tesla/index or ./tesla/oauth.
export { TeslaProvider } from './tesla/index';
export { teslaAuthorizeUrl, teslaExchangeCode } from './tesla/oauth';
