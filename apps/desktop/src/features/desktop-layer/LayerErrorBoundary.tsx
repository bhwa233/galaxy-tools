import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

export class LayerErrorBoundary extends Component<
  { children: ReactNode; label: string; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? (
      <div className="layer-card-fault" role="status">
        <TriangleAlert aria-hidden />
        <span>{this.props.label}</span>
      </div>
    ) : (
      this.props.children
    );
  }
}
