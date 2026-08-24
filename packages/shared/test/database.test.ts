import { describe, expect, it } from 'vitest';
import {
  DATABASE_ENGINES,
  DatabaseName,
  databaseEngineInfo,
  databaseUri,
  databaseUriTemplate,
  engineForComponent,
} from '../src/database.js';

/**
 * The connection URI is the one thing somebody leaves the Databases page with,
 * and the password inside it is shown exactly once. If it is malformed, they
 * find out later, with no way to look it up again.
 */
describe('databaseUri', () => {
  it('uses the scheme each engine is actually reached by', () => {
    expect(databaseUri('mariadb', 'shop', 'shop', 'pw')).toBe(
      'mysql://shop:pw@127.0.0.1:3306/shop',
    );
    expect(databaseUri('postgres', 'shop', 'shop', 'pw')).toBe(
      'postgresql://shop:pw@127.0.0.1:5432/shop',
    );
  });

  it('tells MongoDB where the login lives', () => {
    // The user is created inside its own database, not in `admin`. A driver
    // told nothing looks in `admin`, finds no such user, and reports the
    // password as wrong — which is a miserable thing to debug.
    expect(databaseUri('mongodb', 'shop', 'shop', 'pw')).toBe(
      'mongodb://shop:pw@127.0.0.1:27017/shop?authSource=shop',
    );
  });

  it('encodes a password that would otherwise change the host', () => {
    // A person may choose a password with an @ in it. Unencoded, everything
    // before the last @ becomes the credentials and the URI points somewhere
    // else entirely.
    const uri = databaseUri('postgres', 'shop', 'shop', 'p@ss/word:1');

    expect(uri).toBe('postgresql://shop:p%40ss%2Fword%3A1@127.0.0.1:5432/shop');
    expect(new URL(uri).hostname).toBe('127.0.0.1');
    expect(decodeURIComponent(new URL(uri).password)).toBe('p@ss/word:1');
  });

  it('formats an external IPv6 host for URI consumers', () => {
    const uri = databaseUri('mongodb', 'shop', 'shop', 'pw', '2001:db8::10');
    expect(uri).toBe('mongodb://shop:pw@[2001:db8::10]:27017/shop?authSource=shop');
  });

  it('leaves a placeholder recognisable in the template', () => {
    expect(databaseUriTemplate('mariadb', 'shop', 'shop')).toContain('PASSWORD');
  });

  it('produces a parseable URI for every engine', () => {
    for (const engine of DATABASE_ENGINES) {
      expect(() => new URL(databaseUri(engine.id, 'shop', 'shop', 'pw')), engine.id).not.toThrow();
    }
  });
});

describe('the engine table', () => {
  it('gives every engine a port of its own', () => {
    const ports = DATABASE_ENGINES.map((engine) => engine.port);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('maps each component back to the engine it provides', () => {
    for (const engine of DATABASE_ENGINES) {
      expect(engineForComponent(engine.componentId)).toBe(engine.id);
    }
    expect(engineForComponent('caddy')).toBeNull();
  });

  it('describes every engine it names', () => {
    for (const engine of DATABASE_ENGINES) {
      expect(databaseEngineInfo(engine.id)).toBe(engine);
    }
  });
});

/**
 * The name a person types is put straight into a statement as an identifier,
 * on three engines that each fold or restrict case differently. Holding it to
 * the smallest safe shape is what lets one name work on all of them.
 */
describe('DatabaseName', () => {
  it('accepts a plain lowercase name', () => {
    expect(DatabaseName.safeParse('shop_2').success).toBe(true);
  });

  it('refuses anything that is not a safe identifier', () => {
    for (const bad of ['Shop', 'my shop', 'shop;drop', 'shop-2', '', 'a'.repeat(25)]) {
      expect(DatabaseName.safeParse(bad).success, bad).toBe(false);
    }
  });
});
