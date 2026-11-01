// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_MS, createReaderToast, writeMessage } from "../src/web/reader-toast.js";

const SIGN_IN_LINK = '<a href="/" target="_blank" rel="noopener noreferrer">Sign in</a>';

describe("writeMessage", () => {
  it("writes the text alone, replacing what was there", () => {
    const target = document.createElement("span");
    target.textContent = "old";
    writeMessage(target, "Couldn't save.");
    expect(target.innerHTML).toBe("Couldn't save.");
  });

  it("adds a Sign in link to Outline after the text", () => {
    const target = document.createElement("span");
    writeMessage(target, "Sign in to Outline to tick boxes.", true);
    expect(target.innerHTML).toBe(`Sign in to Outline to tick boxes. ${SIGN_IN_LINK}`);
  });
});

describe("createReaderToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("is a hidden polite status region until a message is shown", () => {
    const { element } = createReaderToast(document);
    expect(element.className).toBe("reader-toast");
    expect(element.getAttribute("role")).toBe("status");
    expect(element.getAttribute("aria-live")).toBe("polite");
    expect(element.hidden).toBe(true);
    expect(element.hasAttribute("style")).toBe(false);
  });

  it("shows a message, keeping a sign-in link, and hides it after TOAST_MS", () => {
    const toast = createReaderToast(document);
    toast.show("Sign in to Outline to tick boxes.", true);
    expect(toast.element.hidden).toBe(false);
    expect(toast.element.innerHTML).toBe(`Sign in to Outline to tick boxes. ${SIGN_IN_LINK}`);
    expect(TOAST_MS).toBe(5000);
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(toast.element.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.element.hidden).toBe(true);
  });

  it("replaces a message with a newer one, which gets its own full time", () => {
    const toast = createReaderToast(document);
    toast.show("First");
    vi.advanceTimersByTime(3000);
    toast.show("Second");
    expect(toast.element.textContent).toBe("Second");
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(toast.element.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.element.hidden).toBe(true);
  });

  it("is dismissed by a tap, and the dismissed message's timer does nothing later", () => {
    const toast = createReaderToast(document);
    document.body.append(toast.element);
    toast.show("First");
    toast.element.click();
    expect(toast.element.hidden).toBe(true);
    vi.advanceTimersByTime(2000);
    toast.show("Second");
    vi.advanceTimersByTime(TOAST_MS - 2000);
    expect(toast.element.hidden).toBe(false);
  });

  it("keeps the link in the page while a tap on it dismisses the toast, so it still opens", () => {
    const toast = createReaderToast(document);
    document.body.append(toast.element);
    toast.show("Sign in to Outline to tick boxes.", true);
    const link = toast.element.querySelector("a") as HTMLAnchorElement;
    link.addEventListener("click", (event) => event.preventDefault()); // jsdom cannot navigate
    link.click();
    expect(toast.element.hidden).toBe(true);
    expect(link.isConnected).toBe(true);
  });

  it("hide hides at once and cancels the timer", () => {
    const toast = createReaderToast(document);
    toast.show("First");
    toast.hide();
    expect(toast.element.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
