import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { TerminalTransportCallbacks } from "@/lib/terminal/transport";
import {
  connect,
  createTransport,
  disconnect,
  disposeTransport,
  sendInput,
  sendResize,
} from "@/lib/terminal/transport";
import type { ConnectionState } from "@/lib/terminal/types";

// Read the HTML asset
const XTERM_HTML = require("@/lib/terminal/xterm.html");

interface TerminalWebViewProps {
  wsUrl: string | null;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onExit?: (exitCode: number, signal: number) => void;
}

export function TerminalWebView({ wsUrl, onConnectionStateChange, onExit }: TerminalWebViewProps) {
  const webViewRef = useRef<WebView>(null);
  const transportRef = useRef(createTransport());

  const postToWebView = useCallback((type: string, data: string) => {
    const msg = JSON.stringify({ type, data });
    const escaped = msg.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    webViewRef.current?.injectJavaScript(`window.postMessage('${escaped}', '*'); true;`);
  }, []);

  // Connect/disconnect when wsUrl changes
  useEffect(() => {
    const transport = transportRef.current;

    if (!wsUrl) {
      disconnect(transport);
      return;
    }

    const callbacks: TerminalTransportCallbacks = {
      onData: (data) => postToWebView("write", data),
      onReplay: (data) => postToWebView("write", data),
      onError: (message) => postToWebView("write", `\r\n[error] ${message}\r\n`),
      onExit: (exitCode, signal) => {
        postToWebView("write", `\r\n[exited: code=${exitCode} signal=${signal}]\r\n`);
        onExit?.(exitCode, signal);
      },
      onStateChange: (state) => onConnectionStateChange?.(state),
    };

    connect(transport, callbacks, wsUrl);

    return () => {
      disconnect(transport);
    };
  }, [wsUrl, postToWebView, onConnectionStateChange, onExit]);

  // Cleanup on unmount
  useEffect(() => {
    const transport = transportRef.current;
    return () => disposeTransport(transport);
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const transport = transportRef.current;
    let msg: { type: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (msg.type === "input" && msg.data) {
      sendInput(transport, msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      sendResize(transport, msg.cols, msg.rows);
    }
  }, []);

  return (
    <View className="flex-1 bg-[#1a1a2e]">
      <WebView
        ref={webViewRef}
        source={XTERM_HTML}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={handleMessage}
        style={{ flex: 1, backgroundColor: "#1a1a2e" }}
        scrollEnabled={false}
        bounces={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={false}
        allowsInlineMediaPlayback
      />
    </View>
  );
}
