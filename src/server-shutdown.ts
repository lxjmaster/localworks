export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
}

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  report: (event: string) => void = () => {},
): Promise<void> {
  report("server_shutdown_started");
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else { report("server_http_drained"); resolve(); }
    });
  }).then(() => undefined, (error: unknown) => ({ error }));

  const waiting = setInterval(() => report("server_shutdown_waiting"), 10_000);
  waiting.unref();
  try {
    report("server_application_close_started");
    await closeApplication();
    report("server_application_closed");
    const httpResult = await httpClosed;
    if (httpResult) throw httpResult.error;
    report("server_shutdown_completed");
  } finally {
    clearInterval(waiting);
  }
}
