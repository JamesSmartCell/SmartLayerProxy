import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface Config {
  serverPort: number;
  udpPort: number;
  tcpPort: number;
}

function loadProperties(): Record<string, string> {
  const paths = [
    join(process.cwd(), 'application.properties'),
    join(__dirname, '..', 'application.properties'),
    join(process.cwd(), '..', 'src', 'main', 'resources', 'application.properties'),
    join(__dirname, '..', '..', 'src', 'main', 'resources', 'application.properties'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      const props: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith(';') && !trimmed.startsWith('#')) {
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.substring(0, eq).trim();
            const val = trimmed.substring(eq + 1).trim();
            props[key] = val;
          }
        }
      }
      return props;
    }
  }

  return {};
}

export function loadConfig(): Config {
  const props = loadProperties();
  return {
    serverPort: parseInt(props['server.port'] || '8081', 10),
    udpPort: parseInt(props['udp.port'] || '8083', 10),
    tcpPort: parseInt(props['tcp.port'] || '8082', 10),
  };
}
