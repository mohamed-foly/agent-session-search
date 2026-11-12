import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessagesPage, SessionHeader, ViewMessage, fetchMessages } from '../api';
import MessageItem from './MessageItem';

const INITIAL_PAGE = 20;
const PAGE = 30;
/** Start loading a page when its end is this close to the visible area. */
const NEAR_PX = 600;

type Block =
  | { type: 'message'; key: number; msg: ViewMessage }
  | { type: 'tools'; key: number; items: ViewMessage[] }
  | { type: 'meta'; key: number; items: ViewMessage[] };

/**
 * Folds the flat message list into display blocks: chat turns stay as they are,
 * consecutive tool steps (with any bookkeeping between them) become one
 * collapsible group, and other runs of bookkeeping records become one
 * "N system events" separator. Keys are the seq of a block's first row.
 */
function buildBlocks(messages: ViewMessage[]): Block[] {
  const blocks: Block[] = [];
  let tools: Extract<Block, { type: 'tools' }> | null = null;
  let meta: Extract<Block, { type: 'meta' }> | null = null;
  let pending: ViewMessage[] = []; // meta seen inside a tool group; belongs to it only if more tool steps follow

  const flushPending = () => {
    if (pending.length > 0) blocks.push({ type: 'meta', key: pending[0].seq, items: pending });
    pending = [];
  };

  for (const m of messages) {
    if (m.kind === 'user' || m.kind === 'assistant') {
      flushPending();
      tools = null;
      meta = null;
      blocks.push({ type: 'message', key: m.seq, msg: m });
    } else if (m.kind === 'meta') {
      if (tools) {
        pending.push(m);
      } else {
        if (!meta) {
          meta = { type: 'meta', key: m.seq, items: [] };
          blocks.push(meta);
        }
        meta.items.push(m);
      }
    } else {
      if (!tools) {
        tools = { type: 'tools', key: m.seq, items: [] };
        blocks.push(tools);
        meta = null;
      }
      if (pending.length > 0) {
        tools.items.push(...pending);
        pending = [];
      }
      tools.items.push(m);
    }
  }
  flushPending();
  return blocks;
}

const blockRows = (b: Block): ViewMessage[] => (b.type === 'message' ? [b.msg] : b.items);

function toolSummary(items: ViewMessage[]): string {
  const calls = items.filter((i) => i.kind === 'tool_call');
  if (calls.length === 0) {
    const results = items.filter((i) => i.kind === 'tool_result').length;
    return results > 0 ? `${results} tool result${results === 1 ? '' : 's'}` : 'tool activity';
  }
  const tally = new Map<string, number>();
  for (const c of calls) tally.set(c.toolName ?? 'tool', (tally.get(c.toolName ?? 'tool') ?? 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return `${calls.length} tool step${calls.length === 1 ? '' : 's'} · ${top.map(([n, c]) => `${n} ×${c}`).join(', ')}`;
}

const dayOf = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toDateString();
};
const formatDay = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

interface Props {
  header: SessionHeader;
  anchorSeq: number;
  terms: string[];
  showMeta: boolean;
}

type Status = 'loading' | 'ready' | 'error';

/**
 * The scrolling conversation: loads a window around the anchor, then more
 * above or below as the user scrolls toward either end.
 */
export default function MessageList({ header, anchorSeq, terms, showMeta }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [loadError, setLoadError] = useState('');
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [hasMoreAfter, setHasMoreAfter] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadingBefore, setLoadingBefore] = useState(false);
  const [loadingAfter, setLoadingAfter] = useState(false);
  const [errorBefore, setErrorBefore] = useState(false);
  const [errorAfter, setErrorAfter] = useState(false);
  const [openKeys, setOpenKeys] = useState<Set<number>>(new Set());
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [anchorSide, setAnchorSide] = useState<'above' | 'below' | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const generation = useRef(0); // bumps on every fresh load, so stale responses are ignored
  const busy = useRef({ before: false, after: false });
  const didInitialScroll = useRef(false);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const setAnchor = useCallback((el: HTMLElement | null) => {
    anchorRef.current = el;
    setAnchorEl(el);
  }, []);

  const { agent, sessionId } = header;

  // Fresh load around the anchor (on open, and when match navigation moves it).
  useEffect(() => {
    const gen = ++generation.current;
    busy.current = { before: false, after: false };
    didInitialScroll.current = false;
    restore.current = null;
    setStatus('loading');
    setMessages([]);
    setErrorBefore(false);
    setErrorAfter(false);
    setLoadingBefore(false);
    setLoadingAfter(false);
    setAnchorSide(null);
    fetchMessages(agent, sessionId, { anchor: anchorSeq, before: INITIAL_PAGE, after: INITIAL_PAGE })
      .then((page: MessagesPage) => {
        if (gen !== generation.current) return;
        // A group or run of system events that holds the anchor starts open, so the match is visible.
        const holder = buildBlocks(page.messages).find((b) => blockRows(b).some((m) => m.seq === anchorSeq));
        setOpenKeys(new Set(holder && holder.type !== 'message' ? [holder.key] : []));
        setMessages(page.messages);
        setHasMoreBefore(page.hasMoreBefore);
        setHasMoreAfter(page.hasMoreAfter);
        setTotal(page.total);
        setStatus('ready');
      })
      .catch((err) => {
        if (gen !== generation.current) return;
        setLoadError(String(err instanceof Error ? err.message : err));
        setStatus('error');
      });
  }, [agent, sessionId, anchorSeq]);

  // Put the match in the middle of the view once, after the first page renders.
  useLayoutEffect(() => {
    if (status !== 'ready' || didInitialScroll.current) return;
    didInitialScroll.current = true;
    let target: Element | null = anchorRef.current;
    if (!target) {
      let best = Infinity;
      for (const el of scrollRef.current?.querySelectorAll<HTMLElement>('[data-seq]') ?? []) {
        const distance = Math.abs(Number(el.dataset.seq) - anchorSeq);
        if (distance < best) {
          best = distance;
          target = el;
        }
      }
    }
    target?.scrollIntoView({ block: 'center' });
  }, [status, messages, anchorSeq]);

  // After older messages are added above, keep what the user was looking at in place.
  useLayoutEffect(() => {
    const saved = restore.current;
    const el = scrollRef.current;
    if (saved && el) {
      el.scrollTop = saved.top + (el.scrollHeight - saved.height);
      restore.current = null;
    }
  }, [messages]);

  const loadOlder = useCallback(async () => {
    const current = messagesRef.current;
    if (busy.current.before || current.length === 0) return;
    const gen = generation.current;
    busy.current.before = true;
    setLoadingBefore(true);
    setErrorBefore(false);
    try {
      const page = await fetchMessages(agent, sessionId, { anchor: current[0].seq, before: PAGE, after: 0 });
      if (gen !== generation.current) return;
      const el = scrollRef.current;
      if (el) restore.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((prev) => [...page.messages, ...prev]);
      setHasMoreBefore(page.hasMoreBefore && page.messages.length > 0); // an empty page means there is nothing more
    } catch {
      if (gen === generation.current) setErrorBefore(true);
    } finally {
      if (gen === generation.current) {
        busy.current.before = false;
        setLoadingBefore(false);
      }
    }
  }, [agent, sessionId]);

  const loadNewer = useCallback(async () => {
    const current = messagesRef.current;
    if (busy.current.after || current.length === 0) return;
    const gen = generation.current;
    busy.current.after = true;
    setLoadingAfter(true);
    setErrorAfter(false);
    try {
      const page = await fetchMessages(agent, sessionId, {
        anchor: current[current.length - 1].seq + 1,
        before: 0,
        after: PAGE,
      });
      if (gen !== generation.current) return;
      setMessages((prev) => [...prev, ...page.messages]);
      setHasMoreAfter(page.hasMoreAfter && page.messages.length > 0);
    } catch {
      if (gen === generation.current) setErrorAfter(true);
    } finally {
      if (gen === generation.current) {
        busy.current.after = false;
        setLoadingAfter(false);
      }
    }
  }, [agent, sessionId]);

  const loaders = useRef({ loadOlder, loadNewer, hasMoreBefore, hasMoreAfter, errorBefore, errorAfter });
  loaders.current = { loadOlder, loadNewer, hasMoreBefore, hasMoreAfter, errorBefore, errorAfter };

  const nearTop = () => {
    const c = scrollRef.current;
    const s = topSentinel.current;
    return !!c && !!s && s.getBoundingClientRect().bottom > c.getBoundingClientRect().top - NEAR_PX;
  };
  const nearBottom = () => {
    const c = scrollRef.current;
    const s = bottomSentinel.current;
    return !!c && !!s && s.getBoundingClientRect().top < c.getBoundingClientRect().bottom + NEAR_PX;
  };

  // Page in more when either end comes within reach. The observer only fires when
  // an end *enters* range, so the effect below also re-checks after every load.
  useEffect(() => {
    const root = scrollRef.current;
    if (status !== 'ready' || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const l = loaders.current;
          if (entry.target === topSentinel.current && l.hasMoreBefore && !l.errorBefore) void l.loadOlder();
          if (entry.target === bottomSentinel.current && l.hasMoreAfter && !l.errorAfter) void l.loadNewer();
        }
      },
      { root, rootMargin: `${NEAR_PX}px 0px` }
    );
    if (topSentinel.current) observer.observe(topSentinel.current);
    if (bottomSentinel.current) observer.observe(bottomSentinel.current);
    return () => observer.disconnect();
  }, [status]);

  useEffect(() => {
    if (status !== 'ready' || didInitialScroll.current === false) return;
    if (hasMoreBefore && !errorBefore && !loadingBefore && nearTop()) void loadOlder();
    if (hasMoreAfter && !errorAfter && !loadingAfter && nearBottom()) void loadNewer();
  }); // every render: cheap, and it is what keeps a short page from stalling the chain

  // Is the matched message on screen? If not, which way is it?
  useEffect(() => {
    const root = scrollRef.current;
    if (!anchorEl || !root) {
      setAnchorSide(null);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setAnchorSide(null);
        else setAnchorSide(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) ? 'above' : 'below');
      },
      { root }
    );
    observer.observe(anchorEl);
    return () => observer.disconnect();
  }, [anchorEl]);

  const blocks = useMemo(() => buildBlocks(messages), [messages]);
  const toggle = (key: number) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const backToMatch = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    anchorRef.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  };

  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  const goToCall = (seq: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    el.classList.add('row-flash');
    window.setTimeout(() => el.classList.remove('row-flash'), 1300);
  };

  const renderItem = (m: ViewMessage) => (
    <MessageItem
      key={m.seq}
      msg={m}
      total={total}
      terms={terms}
      isAnchor={m.seq === anchorSeq}
      anchorRef={setAnchor}
      callRow={m.callSeq !== undefined ? bySeq.get(m.callSeq) : undefined}
      onGoToCall={goToCall}
    />
  );

  let lastDay: string | null = null;
  const rendered = blocks.map((block) => {
    const first = blockRows(block).find((m) => m.timestamp)?.timestamp ?? null;
    const day = dayOf(first);
    let separator = null;
    if (day && day !== lastDay) {
      separator = (
        <div className="day-sep" key={`day-${block.key}`}>
          <span>{formatDay(first as string)}</span>
        </div>
      );
      lastDay = day;
    }

    let body;
    if (block.type === 'message') {
      body = renderItem(block.msg);
    } else if (block.type === 'tools') {
      // Thinking records carry no stored content: a group of only those has nothing to show.
      if (!block.items.some((m) => m.kind === 'tool_call' || m.kind === 'tool_result')) return null;
      const open = openKeys.has(block.key);
      const visible = block.items.filter((m) => m.kind !== 'thinking' && (showMeta || m.kind !== 'meta'));
      body = (
        <div className="tool-group" key={block.key}>
          <button type="button" className="group-toggle" aria-expanded={open} onClick={() => toggle(block.key)}>
            <span className="tool-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
            {toolSummary(block.items)}
          </button>
          {open && visible.map(renderItem)}
        </div>
      );
    } else {
      const open = showMeta || openKeys.has(block.key);
      body = (
        <div className="meta-group" key={block.key}>
          {open ? (
            block.items.map(renderItem)
          ) : (
            <button type="button" className="meta-toggle" aria-expanded={false} onClick={() => toggle(block.key)}>
              · {block.items.length} system event{block.items.length === 1 ? '' : 's'} hidden ·
            </button>
          )}
        </div>
      );
    }
    return (
      <div key={block.key}>
        {separator}
        {body}
      </div>
    );
  });

  if (status === 'loading') {
    return (
      <div className="viewer-body">
        <div className="viewer-scroll" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton skeleton-short" />
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="viewer-body">
        <div className="viewer-scroll">
          <div className="viewer-error" role="alert">Couldn't load this conversation: {loadError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-body">
      <div className="viewer-scroll" ref={scrollRef} role="feed" aria-busy={loadingBefore || loadingAfter} aria-label="Conversation">
        <div ref={topSentinel} />
        {hasMoreBefore ? (
          errorBefore ? (
            <div className="edge-row" role="alert">
              Couldn't load earlier messages.{' '}
              <button type="button" className="copy-btn" onClick={() => void loadOlder()}>Retry</button>
            </div>
          ) : (
            <div className="edge-row">{loadingBefore ? 'Loading earlier messages…' : ''}</div>
          )
        ) : (
          <div className="edge-row edge-marker">
            Start of session{header.startedAt ? ` · ${new Date(header.startedAt).toLocaleString()}` : ''}
          </div>
        )}

        {rendered}

        {hasMoreAfter ? (
          errorAfter ? (
            <div className="edge-row" role="alert">
              Couldn't load later messages.{' '}
              <button type="button" className="copy-btn" onClick={() => void loadNewer()}>Retry</button>
            </div>
          ) : (
            <div className="edge-row">{loadingAfter ? 'Loading later messages…' : ''}</div>
          )
        ) : (
          <div className="edge-row edge-marker">End of indexed messages</div>
        )}
        <div ref={bottomSentinel} />
      </div>
      {anchorSide && (
        <button type="button" className="back-to-match" onClick={backToMatch}>
          {anchorSide === 'above' ? '↑' : '↓'} Back to match
        </button>
      )}
    </div>
  );
}
