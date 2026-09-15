import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create a lightweight DOM simulation for node-based testing
class MockElement {
    tagName: string;
    attributes: Map<string, string> = new Map();
    classList: Set<string> = new Set();
    children: MockElement[] = [];
    parentNode: MockElement | null = null;
    listeners: Map<string, Array<(e: any) => void>> = new Map();
    innerHTML: string = '';
    textContent: string = '';
    shadowRoot: MockShadowRoot | null = null;

    constructor(tagName: string = 'div') {
        this.tagName = tagName.toUpperCase();
        this.classList = {
            add: (...classes: string[]) => classes.forEach((c) => this.classList.add(c)),
            remove: (...classes: string[]) => classes.forEach((c) => this.classList.delete(c)),
            toggle: (c: string, force?: boolean) => {
                if (force !== undefined) {
                    if (force) this.classList.add(c);
                    else this.classList.delete(c);
                    return force;
                }
                if (this.classList.has(c)) {
                    this.classList.delete(c);
                    return false;
                } else {
                    this.classList.add(c);
                    return true;
                }
            },
            has: (c: string) => this.classList.has(c),
            contains: (c: string) => this.classList.has(c),
        } as any;
    }

    setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) || null;
    }

    removeAttribute(name: string) {
        this.attributes.delete(name);
    }

    addEventListener(event: string, callback: (e: any) => void) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(callback);
    }

    removeEventListener(event: string, callback: (e: any) => void) {
        const list = this.listeners.get(event);
        if (list) {
            this.listeners.set(
                event,
                list.filter((cb) => cb !== callback)
            );
        }
    }

    dispatchEvent(event: any): boolean {
        const list = this.listeners.get(event.type) || [];
        list.forEach((cb) => cb(event));
        return true;
    }

    appendChild(child: MockElement): MockElement {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child: MockElement): MockElement {
        this.children = this.children.filter((c) => c !== child);
        child.parentNode = null;
        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    querySelector(selector: string): MockElement | null {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector: string): MockElement[] {
        const results: MockElement[] = [];

        const checkMatch = (el: MockElement): boolean => {
            if (selector.startsWith('.')) {
                const className = selector.slice(1);
                if (className.includes('.')) {
                    const parts = className.split('.');
                    return parts.every((p) => el.classList.has(p));
                }
                return el.classList.has(className);
            }
            if (selector.startsWith('[')) {
                const match = selector.match(/\[(.*?)="(.*?)"\]/);
                if (match) {
                    return el.getAttribute(match[1]) === match[2];
                }
            }
            if (selector.includes('.')) {
                const [tag, ...classes] = selector.split('.');
                const tagMatches = !tag || el.tagName === tag.toUpperCase();
                const classesMatch = classes.every((c) => el.classList.has(c));
                return tagMatches && classesMatch;
            }
            return el.tagName === selector.toUpperCase();
        };

        const traverse = (node: MockElement) => {
            if (checkMatch(node)) {
                results.push(node);
            }
            for (const child of node.children) {
                traverse(child);
            }
        };

        for (const child of this.children) {
            traverse(child);
        }

        return results;
    }

    attachShadow(options: { mode: string }): MockShadowRoot {
        this.shadowRoot = new MockShadowRoot();
        return this.shadowRoot;
    }
}

class MockShadowRoot extends MockElement {
    constructor() {
        super('shadow-root');
    }
}

class MockCustomEvent {
    type: string;
    detail: any;
    bubbles: boolean;
    composed: boolean;
    constructor(type: string, dict: any = {}) {
        this.type = type;
        this.detail = dict.detail;
        this.bubbles = dict.bubbles ?? false;
        this.composed = dict.composed ?? false;
    }
}

class MockMouseEvent {
    type: string;
    stopped: boolean = false;
    defaultPrevented: boolean = false;
    constructor(type: string) {
        this.type = type;
    }
    stopPropagation() {
        this.stopped = true;
    }
    preventDefault() {
        this.defaultPrevented = true;
    }
}

// Setup globals before importing module
(globalThis as any).HTMLElement = MockElement;
(globalThis as any).HTMLSpanElement = MockElement;
(globalThis as any).HTMLAnchorElement = MockElement;
(globalThis as any).HTMLButtonElement = MockElement;
(globalThis as any).HTMLDivElement = MockElement;
(globalThis as any).ShadowRoot = MockShadowRoot;
(globalThis as any).CustomEvent = MockCustomEvent;
(globalThis as any).MouseEvent = MockMouseEvent;
(globalThis as any).customElements = {
    _registry: new Map(),
    define(name: string, constructor: any) {
        this._registry.set(name, constructor);
    },
    get(name: string) {
        return this._registry.get(name);
    },
};
(globalThis as any).document = {
    body: new MockElement('body'),
    createElement(tagName: string) {
        return new MockElement(tagName);
    },
};
(globalThis as any).window = globalThis;
(globalThis as any).requestAnimationFrame = (cb: () => void) => {
    cb();
    return 1;
};

// Now import module under test after DOM globals are initialized
const { BADGE_COMMUNITY_URL, BADGE_LANGUAGES, LANGUAGE_ORDER, NostrCommunityBadge } =
    await import('../src/badge');

describe('Nostr Community Pill Badge Constants & Configuration', () => {
    it('has the correct community URL', () => {
        expect(BADGE_COMMUNITY_URL).toBe('https://nostr.org.tr');
    });

    it('contains exact required language translations', () => {
        expect(BADGE_LANGUAGES.EN.text).toBe('A nostr.org.tr community initiative');
        expect(BADGE_LANGUAGES.TR.text).toBe('Bir nostr.org.tr topluluk girişimidir');
        expect(BADGE_LANGUAGES.ES.text).toBe('Una iniciativa comunitaria de nostr.org.tr');
    });

    it('orders languages as EN, TR, ES', () => {
        expect(LANGUAGE_ORDER).toEqual(['EN', 'TR', 'ES']);
    });
});

describe('NostrCommunityBadge Component Behavior', () => {
    let badge: NostrCommunityBadge;

    beforeEach(() => {
        vi.useFakeTimers();
        badge = new NostrCommunityBadge();
        // Trigger connectedCallback in DOM lifecycle
        badge.connectedCallback();
    });

    afterEach(() => {
        badge.disconnectedCallback();
        vi.useRealTimers();
    });

    it('initializes with default language (EN)', () => {
        expect(badge.getLanguage()).toBe('EN');
    });

    it('switches language immediately when setLanguage is called', () => {
        badge.setLanguage('TR');
        expect(badge.getLanguage()).toBe('TR');
        vi.advanceTimersByTime(250);

        badge.setLanguage('ES');
        expect(badge.getLanguage()).toBe('ES');
    });

    it('cycles languages in sequence EN -> TR -> ES -> EN', () => {
        expect(badge.getLanguage()).toBe('EN');

        badge.nextLanguage();
        expect(badge.getLanguage()).toBe('TR');

        badge.nextLanguage();
        expect(badge.getLanguage()).toBe('ES');

        badge.nextLanguage();
        expect(badge.getLanguage()).toBe('EN');
    });

    it('auto-cycles after interval timeout', () => {
        expect(badge.getLanguage()).toBe('EN');

        vi.advanceTimersByTime(4000);
        expect(badge.getLanguage()).toBe('TR');

        vi.advanceTimersByTime(4000);
        expect(badge.getLanguage()).toBe('ES');

        vi.advanceTimersByTime(4000);
        expect(badge.getLanguage()).toBe('EN');
    });

    it('emits a custom "languagechange" event with transition detail on language switch', () => {
        const listener = vi.fn();
        badge.addEventListener('languagechange', listener);

        badge.setLanguage('ES');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual({
            language: 'ES',
            previousLanguage: 'EN',
            text: 'Una iniciativa comunitaria de nostr.org.tr',
        });
    });

    it('supports custom interval attribute configuration', () => {
        badge.attributeChangedCallback('interval', '4000', '2000');
        expect(badge.getLanguage()).toBe('EN');

        vi.advanceTimersByTime(2000);
        expect(badge.getLanguage()).toBe('TR');
    });

    it('supports disabling and re-enabling auto-cycle via attribute', () => {
        badge.attributeChangedCallback('auto-cycle', 'true', 'false');
        vi.advanceTimersByTime(8000);
        expect(badge.getLanguage()).toBe('EN');

        badge.attributeChangedCallback('auto-cycle', 'false', 'true');
        vi.advanceTimersByTime(4000);
        expect(badge.getLanguage()).toBe('TR');
    });
});
