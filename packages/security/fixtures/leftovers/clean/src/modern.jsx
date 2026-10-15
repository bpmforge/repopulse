// Fixture (W18-07): the React 18 replacements, and an opted-in legacy method.
import React from 'react';
import { createRoot } from 'react-dom/client';

export class Modern extends React.Component {
  UNSAFE_componentWillMount() {
    this.ready = true;
  }

  render() {
    return <input placeholder="https://git.example.com" />;
  }
}

createRoot(document.getElementById('root')).render(<Modern />);
