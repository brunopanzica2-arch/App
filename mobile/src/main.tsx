import "./splash/splash";

// A abertura anima sozinha (CSS); o app pesado só começa a carregar depois da entrada da marca para o parse do JS não travar a animação.
const BOOT_DELAY_MS = 1400;
setTimeout(() => { void import("./boot"); }, BOOT_DELAY_MS);
