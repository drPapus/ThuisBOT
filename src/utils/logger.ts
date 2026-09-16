function timestamp(): string {
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export const logger = {
  info(message: string): void {
    console.log(`[${timestamp()}] ${message}`);
  },
  error(message: string): void {
    console.error(`[${timestamp()}] ERROR: ${message}`);
  },
};
