/** Idempotent bounded drain. Callers decide how to force termination after timeout. */
export function createShutdown(closeHttp: () => Promise<void>, stopWorkers: () => Promise<void>,
    closeResources: () => Promise<void>, timeoutMs = 30_000): () => Promise<boolean> {
    let result: Promise<boolean> | undefined;
    return () => {
        if (result) return result;
        result = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const drained = Promise.all([Promise.resolve().then(closeHttp), Promise.resolve().then(stopWorkers)])
                    .then(closeResources).then(() => true).catch(() => false);
                return await Promise.race([drained, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
            } finally { if (timer) clearTimeout(timer); }
        })();
        return result;
    };
}
