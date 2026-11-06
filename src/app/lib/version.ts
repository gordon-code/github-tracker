export const APP_VERSION: string = __APP_VERSION__;
export const GIT_SHA: string = __GIT_SHA__;
export const BUILD_TIME: string = __BUILD_TIME__;

export function displayVersion(): string {
  return `${APP_VERSION}+${GIT_SHA.slice(0, 7)}`;
}
