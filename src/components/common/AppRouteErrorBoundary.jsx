import { Component } from 'react';

export class AppRouteErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
          <section className="panel w-full max-w-lg space-y-4 p-6 sm:p-8" role="alert">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-300">Page error</p>
            <h1 className="text-xl font-bold text-white">This page could not be displayed</h1>
            <p className="text-sm leading-6 text-slate-300">You can return to Overview or reload this page.</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn-primary" onClick={this.props.onGoHome}>Go to Overview</button>
              <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>Reload page</button>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
