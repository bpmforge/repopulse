// Fixture (W18-07): React APIs removed or deprecated since React 18.
import React from 'react';
import ReactDOM, { findDOMNode } from 'react-dom';
import { render } from 'react-dom';

export class Legacy extends React.Component {
  componentWillMount() {
    this.node = findDOMNode(this);
  }

  componentWillReceiveProps(next) {
    this.setState({ value: next.value });
  }

  render() {
    return <div />;
  }
}

ReactDOM.render(<Legacy />, document.getElementById('root'));
render(<Legacy />, document.getElementById('other'));
